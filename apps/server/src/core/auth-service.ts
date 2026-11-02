import { randomUUID } from 'node:crypto'
import type { DB } from '../db/database.js'
import { conflict, forbidden, notFound, unauthorized } from './errors.js'
import { hashPassword, randomToken, sha256Hex, verifyPassword } from './crypto.js'
import type { ApiTokenInfo, AuthContext, PublicUser, Scope } from './types.js'
import { ALL_SCOPES } from './types.js'

interface UserRow {
  id: string
  email: string
  display_name: string
  password_hash: string
  is_admin: number
  created_at: number
}

interface SessionRow {
  token_hash: string
  user_id: string
  expires_at: number
}

interface ApiTokenRow {
  id: string
  user_id: string
  name: string
  token_hash: string
  scopes: string
  created_at: number
  last_used_at: number | null
  revoked_at: number | null
}

const now = () => Date.now()

export class AuthService {
  constructor(
    private readonly db: DB,
    private readonly sessionTtlHours: number,
  ) {}

  // ----- users -------------------------------------------------------------

  userCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c
  }

  createUser(input: { email: string; password: string; displayName?: string; isAdmin?: boolean }, actor?: AuthContext): PublicUser {
    const email = input.email.trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw conflict('Invalid email address')
    if (input.password.length < 8) throw conflict('Password must be at least 8 characters')
    const existing = this.db.prepare('SELECT id FROM users WHERE email = ?').get(email)
    if (existing) throw conflict('A user with this email already exists')
    const row: UserRow = {
      id: randomUUID(),
      email,
      display_name: input.displayName?.trim() ?? '',
      password_hash: hashPassword(input.password),
      is_admin: input.isAdmin ? 1 : 0,
      created_at: now(),
    }
    this.db
      .prepare('INSERT INTO users (id, email, display_name, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(row.id, row.email, row.display_name, row.password_hash, row.is_admin, row.created_at)
    return toPublicUser(row)
  }

  getUser(userId: string): PublicUser {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow | undefined
    if (!row) throw notFound('User not found')
    return toPublicUser(row)
  }

  listUsers(actor: AuthContext): PublicUser[] {
    this.requireAdmin(actor)
    return (this.db.prepare('SELECT * FROM users ORDER BY created_at').all() as UserRow[]).map(toPublicUser)
  }

  /** First user ever created becomes admin and is allowed without an actor. */
  createUserGuarded(input: { email: string; password: string; displayName?: string; isAdmin?: boolean }, actor?: AuthContext): PublicUser {
    if (this.userCount() === 0) return this.createUser({ ...input, isAdmin: true })
    this.requireAdmin(actor)
    return this.createUser(input)
  }

  deleteUser(userId: string, actor: AuthContext): void {
    this.requireAdmin(actor)
    if (userId === actor.userId) throw conflict('You cannot delete your own account')
    const res = this.db.prepare('DELETE FROM users WHERE id = ?').run(userId)
    if (res.changes === 0) throw notFound('User not found')
  }

  updatePassword(userId: string, newPassword: string, actor: AuthContext): void {
    this.requireAdminOrSelf(userId, actor)
    if (newPassword.length < 8) throw conflict('Password must be at least 8 characters')
    const res = this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), userId)
    if (res.changes === 0) throw notFound('User not found')
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId)
  }

  // ----- web sessions -------------------------------------------------------

  login(email: string, password: string): { user: PublicUser; token: string } {
    const row = this.db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase()) as UserRow | undefined
    // Always run a password verification to keep timing uniform.
    const ok = row ? verifyPassword(password, row.password_hash) : verifyPassword(password, hashPassword('invalid-invalid-invalid'))
    if (!row || !ok) throw unauthorized('Invalid email or password')
    // Opportunistic cleanup: expired sessions are pure garbage.
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now())
    const token = randomToken(32)
    const ttlMs = this.sessionTtlHours * 3600 * 1000
    this.db
      .prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(sha256Hex(token), row.id, now(), now() + ttlMs)
    return { user: toPublicUser(row), token }
  }

  /** Resolve a web session token to an AuthContext. */
  contextForSession(token: string | undefined): AuthContext | null {
    if (!token) return null
    const row = this.db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(sha256Hex(token)) as SessionRow | undefined
    if (!row) return null
    if (row.expires_at < now()) {
      this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(row.token_hash)
      return null
    }
    const user = this.db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id) as UserRow | undefined
    if (!user) return null
    // A web session carries the full scope set for its own user.
    return { userId: user.id, isAdmin: user.is_admin === 1, kind: 'web', scopes: new Set(ALL_SCOPES) }
  }

  logout(token: string | undefined): void {
    if (!token) return
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256Hex(token))
  }

  logoutAllExcept(userId: string, keepTokenHash: string): void {
    this.db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, keepTokenHash)
  }

  // ----- API tokens (agents) -------------------------------------------------

  createToken(userId: string, name: string, scopes: string[]): { info: ApiTokenInfo; token: string } {
    for (const s of scopes) {
      if (!(ALL_SCOPES as readonly string[]).includes(s)) throw conflict(`Unknown scope: ${s}`)
    }
    const raw = `hmt_${randomToken(30)}`
    const id = randomUUID()
    this.db
      .prepare('INSERT INTO api_tokens (id, user_id, name, token_hash, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, userId, name.trim() || 'agent', sha256Hex(raw), JSON.stringify([...new Set(scopes)]), now())
    return { info: this.getToken(id, userId)!, token: raw }
  }

  listTokens(userId: string): ApiTokenInfo[] {
    return (this.db
      .prepare('SELECT * FROM api_tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC')
      .all(userId) as ApiTokenRow[]).map(toTokenInfo)
  }

  revokeToken(userId: string, tokenId: string): void {
    const res = this.db.prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL').run(now(), tokenId, userId)
    if (res.changes === 0) throw notFound('Token not found')
  }

  /**
   * Change an active token's scopes without touching its value: connected
   * agents keep their token, and the new scopes take effect immediately
   * (every request re-reads the row — nothing is cached).
   */
  updateTokenScopes(userId: string, tokenId: string, scopes: string[]): ApiTokenInfo {
    for (const s of scopes) {
      if (!(ALL_SCOPES as readonly string[]).includes(s)) throw conflict(`Unknown scope: ${s}`)
    }
    const res = this.db
      .prepare('UPDATE api_tokens SET scopes = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
      .run(JSON.stringify([...new Set(scopes)]), tokenId, userId)
    if (res.changes === 0) throw notFound('Token not found')
    return this.getToken(tokenId, userId)!
  }

  /** Resolve a Bearer token to an AuthContext. Returns null when invalid. */
  contextForToken(raw: string | undefined): AuthContext | null {
    if (!raw) return null
    return this.contextForTokenHash(sha256Hex(raw))
  }

  /**
   * Resolve a stored token hash to a fresh AuthContext. Used by long-lived
   * MCP sessions so scope changes and revocation apply to the *next* tool
   * call instead of the next session.
   */
  contextForTokenHash(tokenHash: string): AuthContext | null {
    const row = this.db.prepare('SELECT * FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL').get(tokenHash) as
      | ApiTokenRow
      | undefined
    if (!row) return null
    const user = this.db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id) as UserRow | undefined
    if (!user) return null
    this.db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(now(), row.id)
    let scopes: string[] = []
    try {
      const parsed = JSON.parse(row.scopes)
      if (Array.isArray(parsed)) scopes = parsed.filter((s) => typeof s === 'string')
    } catch {
      scopes = []
    }
    return { userId: user.id, isAdmin: user.is_admin === 1, kind: 'token', scopes: new Set(scopes) }
  }

  private getToken(id: string, userId: string): ApiTokenInfo | undefined {
    const row = this.db
      .prepare('SELECT * FROM api_tokens WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
      .get(id, userId) as ApiTokenRow | undefined
    return row ? toTokenInfo(row) : undefined
  }

  // ----- permission helpers ---------------------------------------------------

  /** Throws unless the actor is an administrator. */
  requireAdmin(actor: AuthContext | undefined | null): void {
    if (!actor || !actor.isAdmin) throw forbidden('Administrator access required')
  }

  private requireAdminOrSelf(userId: string, actor: AuthContext): void {
    if (!actor.isAdmin && actor.userId !== userId) throw forbidden('Not allowed')
  }
}

function toPublicUser(row: UserRow): PublicUser {
  return { id: row.id, email: row.email, displayName: row.display_name, isAdmin: row.is_admin === 1, createdAt: row.created_at }
}

function toTokenInfo(row: ApiTokenRow): ApiTokenInfo {
  let scopes: string[] = []
  try {
    const parsed = JSON.parse(row.scopes)
    if (Array.isArray(parsed)) scopes = parsed
  } catch {
    /* keep empty */
  }
  return { id: row.id, name: row.name, scopes, createdAt: row.created_at, lastUsedAt: row.last_used_at }
}

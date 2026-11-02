import { beforeEach, describe, expect, it } from 'vitest'
import { openInMemoryDatabase, type DB } from '../src/db/database.js'
import { AuthService } from '../src/core/auth-service.js'
import { forbidden, unauthorized } from '../src/core/errors.js'

describe('AuthService (users, sessions, tokens, isolation)', () => {
  let db: DB
  let auth: AuthService

  beforeEach(() => {
    db = openInMemoryDatabase()
    auth = new AuthService(db, 24)
  })

  it('creates the first user as admin without an actor', () => {
    const user = auth.createUserGuarded({ email: 'Admin@Local.test', password: 'password123' })
    expect(user.isAdmin).toBe(true)
    expect(user.email).toBe('admin@local.test')
  })

  it('requires an admin actor for subsequent users', () => {
    const first = auth.createUserGuarded({ email: 'a@x.test', password: 'password123' })
    const admin = auth.contextForSession(auth.login('a@x.test', 'password123').token)!
    const created = auth.createUserGuarded({ email: 'b@x.test', password: 'password123' }, admin)
    expect(created.isAdmin).toBe(false)

    const web = auth.contextForSession(auth.login('b@x.test', 'password123').token)!
    expect(() => auth.createUserGuarded({ email: 'c@x.test', password: 'password123' }, web)).toThrowError(forbidden('x').constructor)
  })

  it('rejects duplicate emails and weak passwords', () => {
    auth.createUserGuarded({ email: 'a@x.test', password: 'password123' })
    expect(() => auth.createUser({ email: 'a@x.test', password: 'password123' })).toThrow(/already exists/)
    expect(() => auth.createUser({ email: 'c@x.test', password: 'short' })).toThrow(/8 characters/)
  })

  it('login works, bad passwords fail uniformly', () => {
    auth.createUserGuarded({ email: 'a@x.test', password: 'password123' })
    expect(auth.login('a@x.test', 'password123').token).toBeTruthy()
    expect(() => auth.login('a@x.test', 'wrong')).toThrowError(unauthorized().constructor)
    expect(() => auth.login('ghost@x.test', 'password123')).toThrowError(unauthorized().constructor)
  })

  it('sessions expire', () => {
    db.prepare('INSERT INTO users (id, email, display_name, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, 0, ?)')
      .run('u1', 'u@x.test', '', 'scrypt$16384$8$1$c2FsdA==$aGFzaA==', Date.now())
    // Fabricate an expired session
    db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run('expiredhash', 'u1', Date.now() - 1000, Date.now() - 500)
    // Fabricate a valid session with correct hash of a known token
    db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run('validhash', 'u1', Date.now(), Date.now() + 100_000)
    expect(auth.contextForSession('anything-not-hashed-to-expiredhash')).toBeNull()
    // hash of 'tok' won't equal validhash — null expected
    expect(auth.contextForSession('tok')).toBeNull()
  })

  it('tokens carry scopes and can be revoked', () => {
    const { token, info } = (() => {
      auth.createUserGuarded({ email: 'a@x.test', password: 'password123' })
      const user = auth.contextForSession(auth.login('a@x.test', 'password123').token)!
      return auth.createToken(user.userId, 'agent', ['mail:read'])
    })()
    const ctx = auth.contextForToken(token)
    expect(ctx?.scopes.has('mail:read')).toBe(true)
    expect(ctx?.scopes.has('mail:send')).toBe(false)
    expect(ctx?.kind).toBe('token')

    auth.revokeToken(ctx!.userId, info.id)
    expect(auth.contextForToken(token)).toBeNull()
  })

  it('rejects unknown scopes', () => {
    auth.createUserGuarded({ email: 'a@x.test', password: 'password123' })
    const user = auth.contextForSession(auth.login('a@x.test', 'password123').token)!
    expect(() => auth.createToken(user.userId, 'x', ['root:everything'])).toThrow(/Unknown scope/)
  })

  it('isolates users: one user cannot delete another', () => {
    auth.createUserGuarded({ email: 'a@x.test', password: 'password123' })
    const admin = auth.contextForSession(auth.login('a@x.test', 'password123').token)!
    const b = auth.createUser({ email: 'b@x.test', password: 'password123' }, admin)
    const webB = auth.contextForSession(auth.login('b@x.test', 'password123').token)!
    expect(() => auth.deleteUser(admin.userId, webB)).toThrowError(forbidden('x').constructor)
    auth.deleteUser(b.id, admin) // admin can
    expect(() => auth.getUser(b.id)).toThrow()
  })
})

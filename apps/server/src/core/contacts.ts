import { randomUUID } from 'node:crypto'
import type { DB } from '../db/database.js'
import type { Address, ContactInfo } from './types.js'

interface ContactRow {
  id: string
  user_id: string
  email: string
  name: string
  source: string
  message_count: number
  last_message_at: number | null
  created_at: number
  updated_at: number
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Canonical storage form of a contact email: trimmed and lowercased. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email)
}

function toInfo(row: ContactRow): ContactInfo {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    source: row.source === 'manual' ? 'manual' : 'auto',
    messageCount: row.message_count,
    lastMessageAt: row.last_message_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Per-user address book built automatically from mail traffic (both directions:
 * senders of received mail and recipients of sent mail) and editable manually.
 * Contacts are independent of mail accounts: they belong to the user and
 * survive account removal. Provider-agnostic by construction — harvesting only
 * reads envelopes already cached by the mail engine.
 */
export class ContactStore {
  constructor(private readonly db: DB) {}

  /**
   * Record the participants of one message. Self addresses (the user's own
   * account emails) are skipped, invalid ones too, and each address counts at
   * most once per message. Frequencies/recency feed the autocomplete ranking.
   * Manual contacts keep their name (excluded.name is ignored for them).
   */
  recordAddresses(userId: string, addresses: Address[], messageDate: number | null, selfEmails: ReadonlySet<string>): number {
    const date = messageDate ?? Date.now()
    const seen = new Set<string>()
    const upsert = this.db
      .prepare(
        `INSERT INTO contacts (id, user_id, email, name, source, message_count, last_message_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'auto', 1, ?, ?, ?)
         ON CONFLICT(user_id, email) DO UPDATE SET
           name = CASE WHEN excluded.name != '' AND contacts.source != 'manual' THEN excluded.name ELSE contacts.name END,
           message_count = message_count + 1,
           last_message_at = MAX(COALESCE(contacts.last_message_at, 0), excluded.last_message_at),
           updated_at = excluded.updated_at`,
      )
    let recorded = 0
    for (const a of addresses ?? []) {
      const email = normalizeEmail(a?.email ?? '')
      if (!EMAIL_RE.test(email) || seen.has(email) || selfEmails.has(email)) continue
      seen.add(email)
      upsert.run(randomUUID(), userId, email, (a.name ?? '').trim() || '', date, date, date)
      recorded += 1
    }
    return recorded
  }

  /** All contacts, most frequent / most recent first. */
  list(userId: string, limit: number): ContactInfo[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM contacts WHERE user_id = ?
         ORDER BY message_count DESC, COALESCE(last_message_at, 0) DESC, email ASC LIMIT ?`,
      )
      .all(userId, limit) as ContactRow[]
    return rows.map(toInfo)
  }

  /**
   * Autocomplete candidates: substring match on email or name, prefix matches
   * ranked first, then frequency and recency. An empty query returns the most
   * frequent correspondents (Gmail-style "frequent contacts" view).
   */
  suggest(userId: string, query: string, limit: number): ContactInfo[] {
    const q = query.trim().toLowerCase()
    if (!q) return this.list(userId, limit)
    const escaped = q.replace(/[\\%_]/g, (c) => `\\${c}`)
    const pattern = `%${escaped}%`
    // Bounded candidate window: enough for a good prefix-first rerank without
    // scanning the whole table into JS.
    const rows = this.db
      .prepare(
        `SELECT * FROM contacts WHERE user_id = ?
           AND (email LIKE ? ESCAPE '\\' OR LOWER(name) LIKE ? ESCAPE '\\')
         ORDER BY message_count DESC, COALESCE(last_message_at, 0) DESC, email ASC
         LIMIT 50`,
      )
      .all(userId, pattern, pattern) as ContactRow[]
    const ranked = rows
      .map((row) => ({
        row,
        tier: (row.email.startsWith(q) || row.name.toLowerCase().startsWith(q) ? 0 : 1),
      }))
      .sort((a, b) =>
        a.tier - b.tier ||
        b.row.message_count - a.row.message_count ||
        (b.row.last_message_at ?? 0) - (a.row.last_message_at ?? 0) ||
        a.row.email.localeCompare(b.row.email),
      )
    return ranked.slice(0, limit).map((r) => toInfo(r.row))
  }

  get(userId: string, id: string): ContactInfo | undefined {
    const row = this.db.prepare('SELECT * FROM contacts WHERE user_id = ? AND id = ?').get(userId, id) as ContactRow | undefined
    return row ? toInfo(row) : undefined
  }

  getByEmail(userId: string, email: string): ContactInfo | undefined {
    const row = this.db.prepare('SELECT * FROM contacts WHERE user_id = ? AND email = ?').get(userId, normalizeEmail(email)) as ContactRow | undefined
    return row ? toInfo(row) : undefined
  }

  create(userId: string, email: string, name: string): ContactInfo {
    const now = Date.now()
    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO contacts (id, user_id, email, name, source, message_count, last_message_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'manual', 0, NULL, ?, ?)`,
      )
      .run(id, userId, email, name, now, now)
    return this.get(userId, id)!
  }

  update(userId: string, id: string, patch: { name?: string; email?: string }): ContactInfo | undefined {
    const existing = this.db.prepare('SELECT * FROM contacts WHERE user_id = ? AND id = ?').get(userId, id) as ContactRow | undefined
    if (!existing) return undefined
    this.db
      .prepare('UPDATE contacts SET name = ?, email = ?, updated_at = ? WHERE id = ?')
      .run(patch.name !== undefined ? patch.name.trim() : existing.name, patch.email ?? existing.email, Date.now(), id)
    return this.get(userId, id)
  }

  delete(userId: string, id: string): boolean {
    const res = this.db.prepare('DELETE FROM contacts WHERE user_id = ? AND id = ?').run(userId, id)
    return res.changes > 0
  }
}

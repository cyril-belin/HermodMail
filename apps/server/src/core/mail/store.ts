import { randomUUID } from 'node:crypto'
import type { DB } from '../../db/database.js'
import type {
  Address,
  AttachmentMeta,
  FolderInfo,
  MessageDetail,
  MessageSummary,
  TranslationExtra,
} from '../types.js'
import type { EnvelopeData } from './transport.js'

export interface FolderRow {
  id: string
  account_id: string
  path: string
  delimiter: string
  special_use: string | null
  uidvalidity: number | null
  highest_uid: number
  total_count: number
  unread_count: number
  last_sync_at: number | null
}

export interface MessageRow {
  id: string
  account_id: string
  folder_id: string
  uid: number
  message_id: string | null
  subject: string
  from_json: string
  reply_to_json: string
  in_reply_to: string | null
  references_json: string
  to_json: string
  cc_json: string
  date: number | null
  size: number
  seen: number
  flagged: number
  answered: number
  deleted: number
  draft: number
  has_attachments: number
  snippet: string
  body_text: string | null
  body_html: string | null
  attachments_json: string
  fetched_full: number
  created_at: number
}

export interface ParsedAttachment {
  filename: string
  contentType: string
  content: Buffer
}

const now = () => Date.now()

export class MailStore {
  constructor(private readonly db: DB) {}

  // ----- folders ------------------------------------------------------------

  listFolders(accountId: string): FolderRow[] {
    return this.db.prepare('SELECT * FROM folders WHERE account_id = ? ORDER BY path').all(accountId) as FolderRow[]
  }

  getFolder(accountId: string, path: string): FolderRow | undefined {
    return this.db.prepare('SELECT * FROM folders WHERE account_id = ? AND path = ?').get(accountId, path) as
      | FolderRow
      | undefined
  }

  getFolderById(accountId: string, folderId: string): FolderRow | undefined {
    return this.db.prepare('SELECT * FROM folders WHERE account_id = ? AND id = ?').get(accountId, folderId) as
      | FolderRow
      | undefined
  }

  upsertFolder(accountId: string, f: { path: string; delimiter: string; specialUse: string | null; totalCount?: number; unreadCount?: number }): FolderRow {
    const existing = this.getFolder(accountId, f.path)
    if (existing) {
      this.db
        .prepare(
          `UPDATE folders SET delimiter = ?, special_use = COALESCE(?, special_use),
           total_count = COALESCE(?, total_count), unread_count = COALESCE(?, unread_count) WHERE id = ?`,
        )
        .run(f.delimiter, f.specialUse, f.totalCount ?? null, f.unreadCount ?? null, existing.id)
      return this.getFolder(accountId, f.path)!
    }
    const id = randomUUID()
    this.db
      .prepare('INSERT INTO folders (id, account_id, path, delimiter, special_use, total_count, unread_count) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, accountId, f.path, f.delimiter, f.specialUse, f.totalCount ?? 0, f.unreadCount ?? 0)
    return this.getFolder(accountId, f.path)!
  }

  deleteFolder(folderId: string): void {
    // Explicit message deletion first. (Verified by repro: SQLite FK cascades
    // DO fire triggers, unlike MySQL — so this is belt-and-braces for FTS
    // consistency, not a workaround for missing triggers.)
    this.db.prepare('DELETE FROM messages WHERE folder_id = ?').run(folderId)
    this.db.prepare('DELETE FROM folders WHERE id = ?').run(folderId)
  }

  setFolderSyncState(folderId: string, uidvalidity: number, highestUid: number, totalCount: number, unreadCount: number): void {
    this.db
      .prepare('UPDATE folders SET uidvalidity = ?, highest_uid = ?, total_count = ?, unread_count = ?, last_sync_at = ? WHERE id = ?')
      .run(uidvalidity, highestUid, totalCount, unreadCount, now(), folderId)
  }

  /**
   * Recompute a folder's cached counters from its message rows. Deltas can
   * drift (crashed mutation, flag reconciliation, version skew); a recount is
   * idempotent and keeps the sidebar badge exactly equal to the unread dots
   * the list view renders from the same rows.
   */
  recountFolder(folderId: string): void {
    this.db
      .prepare(
        `UPDATE folders SET
           total_count = (SELECT COUNT(*) FROM messages WHERE folder_id = ?),
           unread_count = (SELECT COUNT(*) FROM messages WHERE folder_id = ? AND seen = 0)
         WHERE id = ?`,
      )
      .run(folderId, folderId, folderId)
  }

  clearFolderMessages(folderId: string): void {
    this.db.prepare('DELETE FROM messages WHERE folder_id = ?').run(folderId)
  }

  /** UIDs currently cached for a folder. */
  listFolderUids(folderId: string): number[] {
    return (this.db.prepare('SELECT uid FROM messages WHERE folder_id = ?').all(folderId) as { uid: number }[]).map((r) => r.uid)
  }

  /** Drop cache rows whose UID no longer exists server-side (remote expunge). */
  deleteUidsNotIn(folderId: string, serverUids: ReadonlySet<number>): number {
    const stale = this.listFolderUids(folderId).filter((uid) => !serverUids.has(uid))
    const del = this.db.prepare('DELETE FROM messages WHERE folder_id = ? AND uid = ?')
    for (const uid of stale) del.run(folderId, uid)
    return stale.length
  }

  // ----- messages -------------------------------------------------------------

  getMessageRow(folderId: string, uid: number): MessageRow | undefined {
    return this.db.prepare('SELECT * FROM messages WHERE folder_id = ? AND uid = ?').get(folderId, uid) as
      | MessageRow
      | undefined
  }

  getMessageRowById(accountId: string, id: string): (MessageRow & { folder_path: string }) | undefined {
    return this.db
      .prepare(
        `SELECT m.*, f.path AS folder_path FROM messages m JOIN folders f ON f.id = m.folder_id
         WHERE m.account_id = ? AND m.id = ?`,
      )
      .get(accountId, id) as (MessageRow & { folder_path: string }) | undefined
  }

  /** Newest cached row of a folder carrying a given Message-Id (draft lookup). */
  findRowByMessageId(folderId: string, messageId: string): MessageRow | undefined {
    return this.db
      .prepare('SELECT * FROM messages WHERE folder_id = ? AND message_id = ? ORDER BY uid DESC')
      .get(folderId, messageId) as MessageRow | undefined
  }

  upsertEnvelope(folderId: string, accountId: string, env: EnvelopeData, snippet?: string): void {
    const existing = this.getMessageRow(folderId, env.uid)
    if (existing) {
      this.db
        .prepare(
          `UPDATE messages SET message_id=?, subject=?, from_json=?, reply_to_json=?, in_reply_to=?, to_json=?, cc_json=?, date=?, size=?,
           seen=?, flagged=?, answered=?, deleted=?, draft=?, has_attachments=?, snippet=COALESCE(?, snippet)
           WHERE id = ?`,
        )
        .run(
          env.messageId,
          env.subject,
          JSON.stringify(env.from),
          JSON.stringify(env.replyTo ?? []),
          env.inReplyTo,
          JSON.stringify(env.to),
          JSON.stringify(env.cc),
          env.date,
          env.size,
          env.seen ? 1 : 0,
          env.flagged ? 1 : 0,
          env.answered ? 1 : 0,
          env.deleted ? 1 : 0,
          env.draft ? 1 : 0,
          env.hasAttachments ? 1 : 0,
          snippet ?? null,
          existing.id,
        )
      return
    }
    this.db
      .prepare(
        `INSERT INTO messages (id, account_id, folder_id, uid, message_id, subject, from_json, reply_to_json, in_reply_to, references_json, to_json, cc_json,
         date, size, seen, flagged, answered, deleted, draft, has_attachments, snippet, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        accountId,
        folderId,
        env.uid,
        env.messageId,
        env.subject,
        JSON.stringify(env.from),
        JSON.stringify(env.replyTo ?? []),
        env.inReplyTo,
        '[]',
        JSON.stringify(env.to),
        JSON.stringify(env.cc),
        env.date,
        env.size,
        env.seen ? 1 : 0,
        env.flagged ? 1 : 0,
        env.answered ? 1 : 0,
        env.deleted ? 1 : 0,
        env.draft ? 1 : 0,
        env.hasAttachments ? 1 : 0,
        snippet ?? '',
        now(),
      )
  }

  updateFlags(
    messageId: string,
    flags: { seen?: boolean; flagged?: boolean; answered?: boolean },
  ): void {
    const sets: string[] = []
    const args: unknown[] = []
    if (flags.seen !== undefined) {
      sets.push('seen = ?')
      args.push(flags.seen ? 1 : 0)
    }
    if (flags.flagged !== undefined) {
      sets.push('flagged = ?')
      args.push(flags.flagged ? 1 : 0)
    }
    if (flags.answered !== undefined) {
      sets.push('answered = ?')
      args.push(flags.answered ? 1 : 0)
    }
    if (!sets.length) return
    args.push(messageId)
    this.db.prepare(`UPDATE messages SET ${sets.join(', ')} WHERE id = ?`).run(...args)
  }

  moveMessageRow(messageId: string, destFolderId: string): void {
    // UID in destination is unknown until resync; delete cached row.
    this.db.prepare('DELETE FROM messages WHERE id = ?').run(messageId)
    void destFolderId
  }

  deleteMessageRow(messageId: string): void {
    this.db.prepare('DELETE FROM messages WHERE id = ?').run(messageId)
  }

  setMessageFull(
    messageId: string,
    data: { bodyText: string; bodyHtml: string | null; snippet: string; attachments: ParsedAttachment[]; maxAttachmentSize: number; references?: string[] },
  ): void {
    this.db
      .prepare('UPDATE messages SET body_text = ?, body_html = ?, snippet = ?, references_json = ?, fetched_full = 1 WHERE id = ?')
      .run(data.bodyText, data.bodyHtml, data.snippet, JSON.stringify(data.references ?? []), messageId)
    const insert = this.db.prepare(
      'INSERT INTO attachments (id, message_row_id, filename, content_type, size, content) VALUES (?, ?, ?, ?, ?, ?)',
    )
    const meta: { id: string; filename: string; contentType: string; size: number }[] = []
    for (const att of data.attachments) {
      const id = randomUUID()
      if (att.content.length > data.maxAttachmentSize) {
        // Too large to store: keep metadata with a marker id so the UI can
        // show it while download attempts fail with a clear error.
        meta.push({ id: `oversize:${id}`, filename: att.filename, contentType: att.contentType, size: att.content.length })
        continue
      }
      insert.run(id, messageId, att.filename, att.contentType, att.content.length, att.content)
      meta.push({ id, filename: att.filename, contentType: att.contentType, size: att.content.length })
    }
    this.db.prepare('UPDATE messages SET attachments_json = ? WHERE id = ?').run(JSON.stringify(meta), messageId)
  }

  listMessageRows(
    folderId: string,
    opts: { limit: number; offset: number; filter?: string; q?: string },
  ): MessageRow[] {
    const conds: string[] = []
    if (opts.filter === 'unseen') conds.push('m.seen = 0')
    if (opts.filter === 'flagged') conds.push('m.flagged = 1')
    if (opts.filter === 'attachments') conds.push('m.has_attachments = 1')
    const tail = 'LIMIT ? OFFSET ?'
    const pagingArgs = [opts.limit, opts.offset]
    if (opts.q) {
      const where = ['m.folder_id = ?', 'message_fts MATCH ?', ...conds]
      const sql = `SELECT m.* FROM messages m JOIN message_fts f ON f.rowid = m.rowid
                   WHERE ${where.join(' AND ')} ORDER BY rank ${tail}`
      return this.db.prepare(sql).all(folderId, ftsQuery(opts.q), ...pagingArgs) as MessageRow[]
    }
    const where = ['folder_id = ?', ...conds.map((c) => c.replace('m.', ''))]
    const sql = `SELECT * FROM messages WHERE ${where.join(' AND ')}
                 ORDER BY COALESCE(date, created_at) DESC, uid DESC ${tail}`
    return this.db.prepare(sql).all(folderId, ...pagingArgs) as MessageRow[]
  }

  countMessages(folderId: string, filter?: string): number {
    let sql = 'SELECT COUNT(*) AS c FROM messages WHERE folder_id = ?'
    if (filter === 'unseen') sql += ' AND seen = 0'
    if (filter === 'flagged') sql += ' AND flagged = 1'
    if (filter === 'attachments') sql += ' AND has_attachments = 1'
    return (this.db.prepare(sql).get(folderId) as { c: number }).c
  }

  searchRows(accountIds: string[], query: string, limit: number): (MessageRow & { folder_path: string })[] {
    const placeholders = accountIds.map(() => '?').join(',')
    return this.db
      .prepare(
        `SELECT m.*, f.path AS folder_path FROM messages m
         JOIN message_fts ft ON ft.rowid = m.rowid
         JOIN folders f ON f.id = m.folder_id
         WHERE m.account_id IN (${placeholders}) AND message_fts MATCH ?
         ORDER BY rank LIMIT ?`,
      )
      .all(...accountIds, ftsQuery(query), limit) as (MessageRow & { folder_path: string })[]
  }

  /** Message rows without a cached body, newest first. */
  rowsWithoutBody(folderId: string, limit: number): MessageRow[] {
    return this.db
      .prepare('SELECT * FROM messages WHERE folder_id = ? AND fetched_full = 0 ORDER BY COALESCE(date, created_at) DESC LIMIT ?')
      .all(folderId, limit) as MessageRow[]
  }

  // ----- attachments ------------------------------------------------------------

  getAttachment(accountId: string, attachmentId: string): { filename: string; contentType: string; size: number; content: Buffer } | undefined {
    const row = this.db
      .prepare(
        `SELECT a.* FROM attachments a JOIN messages m ON m.id = a.message_row_id
         WHERE a.id = ? AND m.account_id = ?`,
      )
      .get(attachmentId, accountId) as
      | { id: string; filename: string; content_type: string; size: number; content: Buffer | null }
      | undefined
    if (!row || !row.content) return undefined
    return { filename: row.filename, contentType: row.content_type, size: row.size, content: Buffer.from(row.content) }
  }

  // ----- AI extras ---------------------------------------------------------------

  getExtras(messageId: string): { summary: string | null; classification: string | null; draftReply: string | null; translation: TranslationExtra | null } | undefined {
    const row = this.db
      .prepare('SELECT summary, classification, draft_reply, translation_json FROM message_extras WHERE message_row_id = ?')
      .get(messageId) as { summary: string | null; classification: string | null; draft_reply: string | null; translation_json: string | null } | undefined
    if (!row) return undefined
    let translation: TranslationExtra | null = null
    if (row.translation_json) {
      try {
        const parsed = JSON.parse(row.translation_json) as TranslationExtra
        if (parsed && typeof parsed === 'object' && typeof parsed.target === 'string') translation = parsed
      } catch {
        /* corrupted extra: treat as absent */
      }
    }
    return { summary: row.summary, classification: row.classification, draftReply: row.draft_reply, translation }
  }

  setExtras(messageId: string, data: { summary?: string; classification?: string; draftReply?: string; translation?: TranslationExtra }): void {
    const translationJson = data.translation !== undefined ? (data.translation ? JSON.stringify(data.translation) : null) : undefined
    this.db
      .prepare(
        `INSERT INTO message_extras (message_row_id, summary, classification, draft_reply, translation_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(message_row_id) DO UPDATE SET
           summary = COALESCE(excluded.summary, summary),
           classification = COALESCE(excluded.classification, classification),
           draft_reply = COALESCE(excluded.draft_reply, draft_reply),
           translation_json = COALESCE(excluded.translation_json, translation_json),
           updated_at = excluded.updated_at`,
      )
      .run(messageId, data.summary ?? null, data.classification ?? null, data.draftReply ?? null, translationJson ?? null, now())
  }
}

/** Build a safe FTS5 query: quoted terms, prefix search on last term. */
export function ftsQuery(input: string): string {
  const terms = input
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}@._-]/gu, ''))
    .filter(Boolean)
    .slice(0, 8)
  if (!terms.length) return '""'
  return terms.map((t) => `"${t}"*`).join(' ')
}

// ----- row mapping helpers ------------------------------------------------------

export function rowToSummary(row: MessageRow, folderPath: string, extras?: { summary?: string | null }): MessageSummary {
  return {
    id: row.id,
    accountId: row.account_id,
    folderId: row.folder_id,
    folderPath,
    uid: row.uid,
    messageId: row.message_id,
    subject: row.subject,
    from: parseAddresses(row.from_json),
    replyTo: parseAddresses(row.reply_to_json),
    to: parseAddresses(row.to_json),
    cc: parseAddresses(row.cc_json),
    date: row.date,
    size: row.size,
    seen: row.seen === 1,
    flagged: row.flagged === 1,
    answered: row.answered === 1,
    draft: row.draft === 1,
    deleted: row.deleted === 1,
    hasAttachments: row.has_attachments === 1,
    snippet: row.snippet,
    summary: extras?.summary ?? undefined,
  }
}

export function rowToDetail(row: MessageRow, folderPath: string, extras?: { summary?: string | null; classification?: string | null; draftReply?: string | null; translation?: TranslationExtra | null }): MessageDetail {
  let attachments: AttachmentMeta[] = []
  try {
    const parsed = JSON.parse(row.attachments_json)
    if (Array.isArray(parsed)) attachments = parsed as AttachmentMeta[]
  } catch {
    /* ignore */
  }
  return {
    ...rowToSummary(row, folderPath, extras),
    bodyText: row.body_text,
    bodyHtml: row.body_html,
    attachments,
    inReplyTo: row.in_reply_to,
    references: parseReferences(row.references_json),
    classification: extras?.classification ?? undefined,
    draftReply: extras?.draftReply ?? undefined,
    translation: extras?.translation ?? undefined,
  }
}

function parseAddresses(json: string): Address[] {
  try {
    const parsed = JSON.parse(json)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((a): a is Address => !!a && typeof (a as Address).email === 'string')
  } catch {
    return []
  }
}

function parseReferences(json: string): string[] {
  try {
    const parsed = JSON.parse(json)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((r): r is string => typeof r === 'string' && r.length > 0)
  } catch {
    return []
  }
}

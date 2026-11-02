import { randomUUID } from 'node:crypto'
import type { DB } from '../../db/database.js'
import type { Config } from '../../config.js'
import { AppError, badRequest, conflict, forbidden, notFound } from '../errors.js'
import { decryptSecret, encryptSecret } from '../crypto.js'
import type {
  Address,
  AuthContext,
  FolderInfo,
  MailAccountInfo,
  MailAccountInput,
  MessageDetail,
  MessageSummary,
  SendMessageInput,
} from '../types.js'
import { SCOPES, isUiLocale, UI_LOCALES } from '../types.js'
import { simpleParser } from 'mailparser'
import { emailHtmlToText, extractSnippet, sanitizeEmailHtml } from './sanitize.js'
import { ContactStore, isValidEmail, normalizeEmail } from '../contacts.js'
import { MailStore, rowToDetail, rowToSummary, type MessageRow } from './store.js'
import type { MailTransport, SmtpSendResult, SmtpSender, TransportConfig, TransportFactory } from './transport.js'
import type { EnvelopeData } from './transport.js'
import type { ContactInfo, SaveDraftInput, SaveDraftResult } from '../types.js'

export interface AccountRow {
  id: string
  user_id: string
  name: string
  email: string
  imap_host: string
  imap_port: number
  imap_tls: string
  imap_user: string
  imap_pass_enc: string
  smtp_host: string
  smtp_port: number
  smtp_tls: string
  smtp_user: string
  smtp_pass_enc: string
  created_at: number
  last_sync_at: number | null
}

export type Logger = (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void

const AUTO_SYNC_INTERVAL_MS = 60_000
const POOL_IDLE_MS = 90_000
const POOL_SWEEP_MS = 15_000
const BODY_BATCH = 5

/** Refresh intervals the UI may pick (ms); 0 = manual only. */
export const REFRESH_INTERVALS_MS = [0, 30_000, 60_000, 120_000, 300_000, 600_000] as const
export const DEFAULT_REFRESH_INTERVAL_MS = 60_000

/**
 * The single place where mail business rules live. Both the web API and the
 * MCP server call into this engine; ownership checks and scope enforcement
 * happen here, never in the adapters.
 */
export class MailEngine {
  private readonly pool = new Map<string, { transport: MailTransport; lastUsed: number }>()
  private readonly indexingFolders = new Set<string>()
  /** In-flight folder syncs, keyed `${accountId}:${path}` — dedupes concurrent syncs. */
  private readonly syncingFolders = new Map<string, Promise<{ newMessages: number; total: number; unread: number }>>()
  private readonly contacts: ContactStore
  private sweeper: NodeJS.Timeout | undefined
  private closed = false

  constructor(
    private readonly db: DB,
    private readonly config: Config,
    private readonly store: MailStore,
    private readonly transportFactory: TransportFactory,
    private readonly smtpSender: SmtpSender,
    private readonly log: Logger = () => {},
  ) {
    this.contacts = new ContactStore(db)
    this.sweeper = setInterval(() => this.sweepPool(), POOL_SWEEP_MS)
    this.sweeper.unref()
  }

  // ----- permissions ---------------------------------------------------------

  private requireScope(ctx: AuthContext, scope: string): void {
    if (!ctx.scopes.has(scope)) {
      throw forbidden(`Missing required scope: ${scope}`)
    }
  }

  /**
   * Account management (adding/removing mailboxes = storing new credentials)
   * is reserved to interactive web sessions. A leaked read-only agent token
   * must never be able to enroll new mailboxes for its owner.
   */
  private requireInteractive(ctx: AuthContext): void {
    if (ctx.kind !== 'web') {
      throw forbidden('Mail account management requires an interactive session (API tokens cannot manage accounts)')
    }
  }

  private getOwnedAccount(ctx: AuthContext, accountId: string): AccountRow {
    const row = this.db.prepare('SELECT * FROM mail_accounts WHERE id = ?').get(accountId) as AccountRow | undefined
    if (!row) throw notFound('Mail account not found')
    if (row.user_id !== ctx.userId) throw forbidden('This mail account belongs to another user')
    return row
  }

  // ----- transport pool ----------------------------------------------------------

  private imapConfig(account: AccountRow): TransportConfig {
    return {
      host: account.imap_host,
      port: account.imap_port,
      tls: (account.imap_tls as TransportConfig['tls']) ?? 'tls',
      user: account.imap_user,
      password: decryptSecret(account.imap_pass_enc, this.config.masterSecret),
    }
  }

  private smtpConfig(account: AccountRow): TransportConfig {
    return {
      host: account.smtp_host,
      port: account.smtp_port,
      tls: (account.smtp_tls as TransportConfig['tls']) ?? 'tls',
      user: account.smtp_user || account.imap_user,
      password: account.smtp_pass_enc
        ? decryptSecret(account.smtp_pass_enc, this.config.masterSecret)
        : decryptSecret(account.imap_pass_enc, this.config.masterSecret),
    }
  }

  private async acquire(account: AccountRow, allowReconnect = true): Promise<MailTransport> {
    const entry = this.pool.get(account.id)
    if (entry) {
      entry.lastUsed = Date.now()
      // Pre-flight health check: IMAP servers close idle connections (30 min
      // is common). Without this, a pooled-but-dead transport hands every
      // operation a "Connection not available" — and mutating operations must
      // never be blindly retried. A NOOP is free and proves the socket is
      // alive BEFORE any real (possibly non-idempotent) command is sent.
      try {
        await entry.transport.noop()
      } catch {
        this.dropTransport(account.id)
        // One reconnect pass only: a freshly built transport skips the check.
        return this.acquire(account, false)
      }
      return entry.transport
    }
    const transport = await this.transportFactory(this.imapConfig(account))
    this.pool.set(account.id, { transport, lastUsed: Date.now() })
    return transport
  }

  /** Drop (and close) the pooled transport for an account, if any. */
  private dropTransport(accountId: string): void {
    const entry = this.pool.get(accountId)
    if (entry) {
      this.pool.delete(accountId)
      void entry.transport.close().catch(() => {})
    }
  }

  private sweepPool(): void {
    const cutoff = Date.now() - POOL_IDLE_MS
    for (const [id, entry] of this.pool) {
      if (entry.lastUsed < cutoff) {
        this.pool.delete(id)
        void entry.transport.close().catch(() => {})
      }
    }
  }

  /**
   * Run a read-only operation against a pooled transport. If the pooled
   * connection turned out to be dead (server dropped it, network change), the
   * transport is discarded+closed and the operation retried once on a fresh
   * connection. Mutating operations are NEVER retried here: a MOVE/EXPUNGE
   * that actually reached the server before the failure is not idempotent,
   * and a blind retry could act on the wrong message.
   */
  private async withReadTransport<T>(account: AccountRow, fn: (t: MailTransport) => Promise<T>): Promise<T> {
    const transport = await this.acquire(account)
    try {
      return await fn(transport)
    } catch (err) {
      const connDead = (err instanceof AppError && err.code === 'mail_connection') || (err instanceof Error && /ETIMEOUT|ECONNRESET|EPIPE|socket/i.test(err.message))
      if (connDead && this.pool.get(account.id)?.transport === transport) {
        this.pool.delete(account.id)
        void transport.close().catch(() => {})
        const fresh = await this.acquire(account)
        return fn(fresh)
      }
      throw err
    }
  }

  // ----- accounts ------------------------------------------------------------

  listAccounts(ctx: AuthContext): MailAccountInfo[] {
    this.requireScope(ctx, SCOPES.mailRead)
    const rows = this.db.prepare('SELECT * FROM mail_accounts WHERE user_id = ? ORDER BY created_at').all(ctx.userId) as AccountRow[]
    return rows.map(toAccountInfo)
  }

  async addAccount(ctx: AuthContext, input: MailAccountInput): Promise<MailAccountInfo> {
    this.requireScope(ctx, SCOPES.mailRead)
    this.requireInteractive(ctx)
    this.validateAccountInput(input)
    const imapCfg: TransportConfig = {
      host: input.imap.host,
      port: input.imap.port,
      tls: input.imap.tls,
      user: input.imap.user,
      password: input.imap.password,
    }
    // Validate by actually connecting and listing folders.
    const probe = await this.transportFactory(imapCfg)
    try {
      await probe.listFolders()
    } finally {
      await probe.close()
    }
    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO mail_accounts (id, user_id, name, email, imap_host, imap_port, imap_tls, imap_user, imap_pass_enc,
         smtp_host, smtp_port, smtp_tls, smtp_user, smtp_pass_enc, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        ctx.userId,
        input.name.trim(),
        input.email.trim(),
        input.imap.host.trim(),
        input.imap.port,
        input.imap.tls,
        input.imap.user.trim(),
        encryptSecret(input.imap.password, this.config.masterSecret),
        input.smtp.host.trim(),
        input.smtp.port,
        input.smtp.tls,
        (input.smtp.user ?? input.imap.user).trim(),
        input.smtp.password ? encryptSecret(input.smtp.password, this.config.masterSecret) : '',
        Date.now(),
      )
    // Prime folder cache immediately.
    const account = this.getOwnedAccount(ctx, id)
    try {
      await this.refreshFolderList(account.id)
    } catch (err) {
      this.log('warn', 'Initial folder listing failed after add', { accountId: id, err: String(err) })
    }
    return toAccountInfo(account)
  }

  async updateAccount(
    ctx: AuthContext,
    accountId: string,
    input: {
      name?: string
      email?: string
      imap?: { host?: string; port?: number; tls?: MailAccountInput['imap']['tls']; user?: string; password?: string }
      smtp?: { host?: string; port?: number; tls?: MailAccountInput['smtp']['tls']; user?: string; password?: string }
    },
  ): Promise<MailAccountInfo> {
    this.requireScope(ctx, SCOPES.mailRead)
    this.requireInteractive(ctx)
    const account = this.getOwnedAccount(ctx, accountId)
    const imapHost = input.imap?.host?.trim() ?? account.imap_host
    const imapPort = input.imap?.port ?? account.imap_port
    const imapTls = input.imap?.tls ?? (account.imap_tls as MailAccountInput['imap']['tls'])
    const imapUser = input.imap?.user?.trim() ?? account.imap_user
    const imapPass = input.imap?.password ?? null
    if (input.imap && (imapHost !== account.imap_host || imapPort !== account.imap_port || imapUser !== account.imap_user || imapPass)) {
      const probe = await this.transportFactory({
        host: imapHost,
        port: imapPort,
        tls: imapTls,
        user: imapUser,
        password: imapPass ?? decryptSecret(account.imap_pass_enc, this.config.masterSecret),
      })
      try {
        await probe.listFolders()
      } finally {
        await probe.close()
      }
    }
    this.db
      .prepare(
        `UPDATE mail_accounts SET name=?, email=?, imap_host=?, imap_port=?, imap_tls=?, imap_user=?, imap_pass_enc=?,
         smtp_host=?, smtp_port=?, smtp_tls=?, smtp_user=?, smtp_pass_enc=? WHERE id=?`,
      )
      .run(
        input.name?.trim() ?? account.name,
        input.email?.trim() ?? account.email,
        imapHost,
        imapPort,
        imapTls,
        imapUser,
        imapPass ? encryptSecret(imapPass, this.config.masterSecret) : account.imap_pass_enc,
        input.smtp?.host?.trim() ?? account.smtp_host,
        input.smtp?.port ?? account.smtp_port,
        input.smtp?.tls ?? account.smtp_tls,
        input.smtp?.user !== undefined ? input.smtp.user.trim() : account.smtp_user,
        input.smtp?.password ? encryptSecret(input.smtp.password, this.config.masterSecret) : account.smtp_pass_enc,
        accountId,
      )
    // Credentials may have changed: discard and CLOSE any pooled connection.
    const stale = this.pool.get(accountId)
    if (stale) {
      this.pool.delete(accountId)
      void stale.transport.close().catch(() => {})
    }
    return toAccountInfo(this.getOwnedAccount(ctx, accountId))
  }

  deleteAccount(ctx: AuthContext, accountId: string): void {
    this.requireScope(ctx, SCOPES.mailRead)
    this.requireInteractive(ctx)
    this.getOwnedAccount(ctx, accountId)
    this.dropTransport(accountId)
    this.db.prepare('DELETE FROM mail_accounts WHERE id = ?').run(accountId)
  }

  async testAccount(ctx: AuthContext, accountId: string): Promise<{ ok: true; folders: number }> {
    this.requireScope(ctx, SCOPES.mailRead)
    this.requireInteractive(ctx)
    const account = this.getOwnedAccount(ctx, accountId)
    const probe = await this.transportFactory(this.imapConfig(account))
    try {
      const folders = await probe.listFolders()
      return { ok: true, folders: folders.length }
    } finally {
      await probe.close()
    }
  }

  private validateAccountInput(input: MailAccountInput): void {
    if (!input.name?.trim()) throw badRequest('Account name is required')
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email ?? '')) throw badRequest('A valid email address is required')
    if (!input.imap?.host || !input.imap.port) throw badRequest('IMAP host and port are required')
    if (!input.imap.user || !input.imap.password) throw badRequest('IMAP credentials are required')
    if (!input.smtp?.host || !input.smtp.port) throw badRequest('SMTP host and port are required')
  }

  // ----- folders ----------------------------------------------------------------

  async refreshFolderList(accountId: string): Promise<void> {
    const account = this.db.prepare('SELECT * FROM mail_accounts WHERE id = ?').get(accountId) as AccountRow
    if (!account) throw notFound('Mail account not found')
    const transport = await this.acquire(account)
    const folders = await transport.listFolders()
    const seen = new Set<string>()
    for (const f of folders) {
      this.store.upsertFolder(accountId, f)
      seen.add(f.path)
    }
    // Drop cached folders that no longer exist server-side. NEVER wipe when
    // the server reports an empty list: a transient or limited LIST response
    // must not erase the local cache (folders + cascaded messages).
    if (folders.length > 0) {
      for (const row of this.store.listFolders(accountId)) {
        if (!seen.has(row.path)) this.store.deleteFolder(row.id)
      }
    }
  }

  async listFolders(ctx: AuthContext, accountId: string, opts: { refresh?: boolean } = {}): Promise<FolderInfo[]> {
    this.requireScope(ctx, SCOPES.mailRead)
    const account = this.getOwnedAccount(ctx, accountId)
    if (opts.refresh) await this.refreshFolderList(accountId)
    return this.store.listFolders(accountId).map((row) => ({
      id: row.id,
      path: row.path,
      delimiter: row.delimiter,
      specialUse: row.special_use,
      totalCount: row.total_count,
      unreadCount: row.unread_count,
      lastSyncAt: row.last_sync_at,
    }))
  }

  async createFolder(ctx: AuthContext, accountId: string, path: string): Promise<FolderInfo[]> {
    this.requireScope(ctx, SCOPES.folderWrite)
    const account = this.getOwnedAccount(ctx, accountId)
    if (!path.trim()) throw badRequest('Folder path is required')
    if (path.trim().toUpperCase() === 'INBOX') throw badRequest('Creating a folder named INBOX is not allowed')
    const transport = await this.acquire(account)
    await transport.createFolder(path.trim())
    await this.refreshFolderList(accountId)
    return this.listFolders(ctx, accountId)
  }

  async renameFolder(ctx: AuthContext, accountId: string, path: string, newPath: string): Promise<FolderInfo[]> {
    this.requireScope(ctx, SCOPES.folderWrite)
    const account = this.getOwnedAccount(ctx, accountId)
    const folder = this.store.getFolder(accountId, path)
    if (path.trim().toUpperCase() === 'INBOX' || newPath.trim().toUpperCase() === 'INBOX') {
      throw badRequest('INBOX cannot be created or renamed')
    }
    if (folder?.special_use) throw badRequest(`Folder "${path}" is a system folder (${folder.special_use}) and cannot be renamed`)
    if (!newPath.trim()) throw badRequest('New folder path is required')
    const transport = await this.acquire(account)
    await transport.renameFolder(path, newPath)
    if (folder) this.store.deleteFolder(folder.id)
    await this.refreshFolderList(accountId)
    return this.listFolders(ctx, accountId)
  }

  /**
   * Delete a real IMAP folder. System folders (INBOX + special-use) are never
   * deletable; a non-empty folder requires an explicit confirm so an agent
   * (or a fat-fingered call) cannot wipe messages in one shot.
   */
  async deleteFolder(ctx: AuthContext, accountId: string, path: string, opts?: { confirm?: boolean }): Promise<FolderInfo[]> {
    this.requireScope(ctx, SCOPES.folderDelete)
    const account = this.getOwnedAccount(ctx, accountId)
    if (path.trim().toUpperCase() === 'INBOX') throw badRequest('INBOX cannot be deleted')
    const folder = this.store.getFolder(accountId, path)
    if (folder?.special_use) throw badRequest(`Folder "${path}" is a system folder (${folder.special_use}) and cannot be deleted`)
    if (folder && folder.total_count > 0 && !opts?.confirm) {
      throw badRequest(`Folder "${path}" still contains ${folder.total_count} message(s). Pass confirm=true to delete it anyway.`)
    }
    const transport = await this.acquire(account)
    await transport.deleteFolder(path)
    if (folder) this.store.deleteFolder(folder.id)
    await this.refreshFolderList(accountId)
    return this.listFolders(ctx, accountId)
  }

  // ----- sync -------------------------------------------------------------------

  async syncFolder(ctx: AuthContext, accountId: string, path: string): Promise<{ newMessages: number; total: number; unread: number }> {
    this.requireScope(ctx, SCOPES.mailRead)
    // Object-level check: a stranger must never trigger a sync (nor receive
    // its {total, unread} metadata) on an account they do not own.
    this.getOwnedAccount(ctx, accountId)
    return this.syncFolderInternal(accountId, path)
  }

  private async syncFolderInternal(accountId: string, path: string): Promise<{ newMessages: number; total: number; unread: number }> {
    // Never run two concurrent syncs of the same folder: a second caller waits
    // for the in-flight one instead of opening a parallel IMAP session.
    const key = `${accountId}:${path}`
    const inFlight = this.syncingFolders.get(key)
    if (inFlight) return inFlight
    const promise = this.doSyncFolder(accountId, path).finally(() => {
      if (this.syncingFolders.get(key) === promise) this.syncingFolders.delete(key)
    })
    this.syncingFolders.set(key, promise)
    return promise
  }

  private async doSyncFolder(accountId: string, path: string): Promise<{ newMessages: number; total: number; unread: number }> {
    const account = this.db.prepare('SELECT * FROM mail_accounts WHERE id = ?').get(accountId) as AccountRow
    if (!account) throw notFound('Mail account not found')
    let folder = this.store.getFolder(accountId, path)
    if (!folder) {
      await this.refreshFolderList(accountId)
      folder = this.store.getFolder(accountId, path)
      if (!folder) throw notFound(`Folder not found: ${path}`)
    }
    const result = await this.withReadTransport(account, (t) =>
      t.syncFolder(path, folder.uidvalidity, folder.highest_uid, this.config.initialSyncLimit),
    )

    if (folder.uidvalidity !== null && result.uidvalidity !== folder.uidvalidity) {
      this.store.clearFolderMessages(folder.id)
    }
    for (const env of result.newMessages) {
      this.store.upsertEnvelope(folder.id, accountId, env)
    }
    // Address book: every correspondent of newly synced messages (senders,
    // recipients — both directions) lands in the per-user contacts, except the
    // user's own account emails. Best-effort: never fails a sync.
    if (result.newMessages.length > 0) this.harvestContacts(account, result.newMessages)
    for (const [uid, flags] of result.flags) {
      const row = this.store.getMessageRow(folder.id, uid)
      if (row) {
        this.store.updateFlags(row.id, {
          seen: flags.seen,
          flagged: flags.flagged,
          answered: flags.answered,
        })
      }
    }
    // Remote expunge reconciliation: the incremental window never reports
    // deletions, so a shrinking server-side count triggers a UID listing.
    if (result.totalCount < this.store.countMessages(folder.id)) {
      const serverUids = new Set(await this.withReadTransport(account, (t) => t.listUids(path)))
      this.store.deleteUidsNotIn(folder.id, serverUids)
    }
    const highest = result.newMessages.reduce((max, m) => Math.max(max, m.uid), folder.highest_uid)
    this.store.setFolderSyncState(folder.id, result.uidvalidity, highest, result.totalCount, result.unreadCount)
    // The badge and the list dots read the same rows: derive the counters from
    // the just-reconciled rows instead of trusting STATUS alone, so the two
    // can never disagree (server STATUS quirks, partial flag windows…).
    this.store.recountFolder(folder.id)
    this.db.prepare('UPDATE mail_accounts SET last_sync_at = ? WHERE id = ?').run(Date.now(), accountId)

    if (result.newMessages.length > 0) void this.indexBodies(accountId, folder.id).catch(() => {})
    return { newMessages: result.newMessages.length, total: result.totalCount, unread: result.unreadCount }
  }

  /** Background job: fetch bodies of recent messages so search & AI work. */
  private async indexBodies(accountId: string, folderId: string): Promise<void> {
    if (this.closed || this.indexingFolders.has(folderId)) return
    this.indexingFolders.add(folderId)
    try {
      const rows = this.store.rowsWithoutBody(folderId, this.config.bodyIndexLimit)
      for (let i = 0; i < rows.length; i += BODY_BATCH) {
        if (this.closed) return
        const batch = rows.slice(i, i + BODY_BATCH)
        await Promise.all(
          batch.map(async (row) => {
            try {
              await this.fetchAndCacheFull(accountId, row)
            } catch (err) {
              this.log('warn', 'body index fetch failed', { uid: row.uid, err: String(err) })
            }
          }),
        )
      }
    } finally {
      this.indexingFolders.delete(folderId)
    }
  }

  private async fetchAndCacheFull(accountId: string, row: MessageRow): Promise<MessageRow> {
    const account = this.db.prepare('SELECT * FROM mail_accounts WHERE id = ?').get(accountId) as AccountRow
    const folder = this.store.getFolderById(accountId, row.folder_id)
    if (!folder) throw notFound('Folder missing')
    const source = await this.withReadTransport(account, (t) => t.fetchMessageSource(folder.path, row.uid))
    if (!source) {
      // Message vanished server-side; drop the stale cache row.
      this.store.deleteMessageRow(row.id)
      throw notFound('Message no longer exists on the server')
    }
    const parsed = await simpleParser(source)
    const text = parsed.text?.trim() || (parsed.html ? emailHtmlToText(parsed.html) : '')
    const html = parsed.html ? sanitizeEmailHtml(parsed.html) : null
    const rawReferences = parsed.references
    const references = (Array.isArray(rawReferences) ? rawReferences : rawReferences ? [rawReferences] : [])
      .map((r) => r.replace(/[<>]/g, '').trim())
      .filter(Boolean)
    const attachments = (parsed.attachments ?? []).map((a, i) => ({
      filename: a.filename || `attachment-${i + 1}`,
      contentType: a.contentType || 'application/octet-stream',
      content: a.content,
    }))
    this.store.setMessageFull(row.id, {
      bodyText: text,
      bodyHtml: html,
      snippet: extractSnippet(text || parsed.subject || ''),
      attachments,
      maxAttachmentSize: this.config.maxAttachmentSize,
      references,
    })
    return this.store.getMessageRow(row.folder_id, row.uid) ?? row
  }

  // ----- messages ----------------------------------------------------------------

  async listMessages(
    ctx: AuthContext,
    accountId: string,
    query: { folder: string; page?: number; limit?: number; filter?: string; q?: string; sync?: boolean },
  ): Promise<{ messages: MessageSummary[]; total: number; page: number; limit: number }> {
    this.requireScope(ctx, SCOPES.mailRead)
    const account = this.getOwnedAccount(ctx, accountId)
    let folder = this.store.getFolder(accountId, query.folder)
    const shouldSync = query.sync !== false && (!folder || !folder.last_sync_at || Date.now() - folder.last_sync_at > AUTO_SYNC_INTERVAL_MS)
    if (shouldSync) {
      try {
        await this.syncFolderInternal(accountId, query.folder)
        folder = this.store.getFolder(accountId, query.folder)
      } catch (err) {
        this.log('warn', 'auto-sync failed; serving cache', { accountId, folder: query.folder, err: String(err) })
      }
    }
    if (!folder) throw notFound(`Folder not found: ${query.folder}`)
    const page = Math.max(1, query.page ?? 1)
    const limit = Math.min(100, Math.max(1, query.limit ?? 50))
    const rows = this.store.listMessageRows(folder.id, {
      limit,
      offset: (page - 1) * limit,
      filter: query.filter,
      q: query.q,
    })
    const total = this.store.countMessages(folder.id, query.filter)
    void account
    return { messages: rows.map((r) => rowToSummary(r, folder!.path)), total, page, limit }
  }

  async getMessage(ctx: AuthContext, accountId: string, folderPath: string, uid: number, opts: { markSeen?: boolean } = {}): Promise<MessageDetail> {
    this.requireScope(ctx, SCOPES.mailRead)
    const account = this.getOwnedAccount(ctx, accountId)
    const folder = this.store.getFolder(accountId, folderPath)
    if (!folder) throw notFound(`Folder not found: ${folderPath}`)
    let row = this.store.getMessageRow(folder.id, uid)
    if (!row) {
      // Might be a message we have not synced yet; try a folder sync first.
      try {
        await this.syncFolderInternal(accountId, folderPath)
      } catch {
        /* offline: fall through */
      }
      row = this.store.getMessageRow(folder.id, uid)
    }
    if (!row) throw notFound('Message not found')
    if (!row.fetched_full) {
      row = await this.fetchAndCacheFull(accountId, row)
    }
    const markSeen = opts.markSeen ?? true
    if (markSeen && !row.seen) {
      const transport = await this.acquire(account)
      await transport.updateFlags(folder.path, uid, { add: ['\\Seen'] })
      this.store.updateFlags(row.id, { seen: true })
      this.store.recountFolder(folder.id)
      row.seen = 1
    }
    const extras = this.store.getExtras(row.id)
    return rowToDetail(row, folder.path, extras)
  }

  async patchMessage(
    ctx: AuthContext,
    accountId: string,
    folderPath: string,
    uid: number,
    patch: { seen?: boolean; flagged?: boolean },
  ): Promise<MessageDetail> {
    this.requireScope(ctx, SCOPES.mailWrite)
    const account = this.getOwnedAccount(ctx, accountId)
    const folder = this.store.getFolder(accountId, folderPath)
    if (!folder) throw notFound(`Folder not found: ${folderPath}`)
    const row = this.store.getMessageRow(folder.id, uid)
    if (!row) throw notFound('Message not found')
    const transport = await this.acquire(account)
    const add: string[] = []
    const remove: string[] = []
    if (patch.seen !== undefined) (patch.seen ? add : remove).push('\\Seen')
    if (patch.flagged !== undefined) (patch.flagged ? add : remove).push('\\Flagged')
    if (add.length || remove.length) await transport.updateFlags(folder.path, uid, { add, remove })
    this.store.updateFlags(row.id, patch)
    // Keep the folder badge truthful between syncs: flipping \Seen moves the
    // message in or out of the unread counter.
    if (patch.seen !== undefined && patch.seen !== (row.seen === 1)) {
      this.store.recountFolder(folder.id)
    }
    const updated = this.store.getMessageRow(folder.id, uid) ?? row
    return rowToDetail(updated, folder.path, this.store.getExtras(updated.id))
  }

  async moveMessage(ctx: AuthContext, accountId: string, folderPath: string, uid: number, destPath: string): Promise<void> {
    this.requireScope(ctx, SCOPES.mailWrite)
    const account = this.getOwnedAccount(ctx, accountId)
    const folder = this.store.getFolder(accountId, folderPath)
    const dest = this.store.getFolder(accountId, destPath)
    if (!folder) throw notFound(`Folder not found: ${folderPath}`)
    if (!dest) throw notFound(`Destination folder not found: ${destPath}`)
    const row = this.store.getMessageRow(folder.id, uid)
    if (!row) throw notFound('Message not found')
    const transport = await this.acquire(account)
    await transport.moveMessage(folder.path, uid, dest.path)
    this.store.moveMessageRow(row.id, dest.id)
    // The cached row is dropped (the destination UID is unknown until resync);
    // pull the destination now so the message reappears there immediately and
    // both folders' counters are recounted from real rows.
    this.store.recountFolder(folder.id)
    try {
      await this.syncFolderInternal(accountId, dest.path)
    } catch (err) {
      this.log('warn', 'post-move destination sync failed', { accountId, dest: dest.path, err: String(err) })
    }
    this.store.recountFolder(dest.id)
  }

  async deleteMessage(ctx: AuthContext, accountId: string, folderPath: string, uid: number): Promise<void> {
    this.requireScope(ctx, SCOPES.mailDelete)
    const account = this.getOwnedAccount(ctx, accountId)
    const folder = this.store.getFolder(accountId, folderPath)
    if (!folder) throw notFound(`Folder not found: ${folderPath}`)
    const row = this.store.getMessageRow(folder.id, uid)
    if (!row) throw notFound('Message not found')
    const transport = await this.acquire(account)
    const trash = this.findSpecialFolder(accountId, 'trash')
    if (folder.special_use === 'trash' || (trash && trash.id === folder.id)) {
      await transport.expungeMessage(folder.path, uid)
      this.store.deleteMessageRow(row.id)
      this.store.recountFolder(folder.id)
    } else if (trash) {
      await transport.moveMessage(folder.path, uid, trash.path)
      this.store.moveMessageRow(row.id, trash.id)
      this.store.recountFolder(folder.id)
      try {
        await this.syncFolderInternal(accountId, trash.path)
      } catch (err) {
        this.log('warn', 'post-delete trash sync failed', { accountId, err: String(err) })
      }
      this.store.recountFolder(trash.id)
    } else {
      await transport.expungeMessage(folder.path, uid)
      this.store.deleteMessageRow(row.id)
      this.store.recountFolder(folder.id)
    }
  }

  private findSpecialFolder(accountId: string, role: string): { id: string; path: string } | null {
    const rows = this.store.listFolders(accountId)
    const byUse = rows.find((r) => r.special_use === role)
    if (byUse) return { id: byUse.id, path: byUse.path }
    const fallbackNames: Record<string, string[]> = {
      trash: ['trash', 'corbeille', 'deleted items', 'deleted messages'],
      sent: ['sent', 'sent messages', 'sent items', 'envoyés', 'envoyes'],
      drafts: ['drafts', 'brouillons'],
      junk: ['junk', 'spam', 'indésirables', 'indesirables'],
    }
    const names = fallbackNames[role] ?? []
    const byName = rows.find((r) => names.includes(r.path.toLowerCase()))
    return byName ? { id: byName.id, path: byName.path } : null
  }

  // ----- search & export -----------------------------------------------------------

  searchMessages(ctx: AuthContext, opts: { accountId?: string; query: string; limit?: number }): MessageSummary[] {
    this.requireScope(ctx, SCOPES.mailRead)
    const ids = opts.accountId
      ? [this.getOwnedAccount(ctx, opts.accountId).id]
      : (this.db.prepare('SELECT id FROM mail_accounts WHERE user_id = ?').all(ctx.userId) as { id: string }[]).map((r) => r.id)
    if (!ids.length) return []
    const rows = this.store.searchRows(ids, opts.query, Math.min(200, opts.limit ?? 50))
    return rows.map((r) => rowToSummary(r, r.folder_path))
  }

  exportMarkdown(ctx: AuthContext, accountId: string, folderPath: string, uid: number): Promise<string> {
    return this.getMessage(ctx, accountId, folderPath, uid, { markSeen: false }).then((m) => messageToMarkdown(m))
  }

  getAttachment(ctx: AuthContext, accountId: string, attachmentId: string) {
    this.requireScope(ctx, SCOPES.mailRead)
    this.getOwnedAccount(ctx, accountId)
    const att = this.store.getAttachment(accountId, attachmentId)
    if (!att) throw notFound('Attachment not found or too large to be stored')
    return att
  }

  // ----- send ------------------------------------------------------------------------

  async sendMessage(ctx: AuthContext, input: SendMessageInput): Promise<SmtpSendResult & { savedToSent: boolean }> {
    this.requireScope(ctx, SCOPES.mailSend)
    const account = this.getOwnedAccount(ctx, input.accountId)
    const to = cleanAddresses(input.to)
    const cc = cleanAddresses(input.cc)
    const bcc = cleanAddresses(input.bcc)
    if (!to.length && !cc.length && !bcc.length) throw badRequest('At least one recipient is required')
    let text = input.text?.trim() ?? ''
    if (!text && input.html) text = emailHtmlToText(input.html)
    if (!text && !input.html) throw badRequest('Message body (text or html) is required')
    const subject = (input.subject ?? '').trim() || '(no subject)'
    const messageId = `<${randomUUID()}@hermodmail.local>`

    const { buildRawMail } = await import('./compose.js')
    const raw = await buildRawMail({
      from: { name: account.name, email: account.email },
      to,
      cc,
      bcc,
      subject,
      text,
      html: input.html,
      inReplyTo: input.inReplyTo,
      references: input.references,
      messageId,
      attachments: (input.attachments ?? []).map((a) => ({
        filename: a.filename,
        contentType: a.contentType,
        content: Buffer.from(a.contentBase64, 'base64'),
      })),
    })
    const result = await this.smtpSender(this.smtpConfig(account), raw, {
      from: account.email,
      to: [...to, ...cc, ...bcc].map((a) => a.email),
    }, messageId)

    let savedToSent = false
    try {
      const sent = this.findSpecialFolder(account.id, 'sent')
      if (sent) {
        const transport = await this.acquire(account)
        await transport.appendMessage(sent.path, raw, ['\\Seen'])
        savedToSent = true
        void this.syncFolderInternal(account.id, sent.path).catch(() => {})
      }
    } catch (err) {
      this.log('warn', 'sent-message APPEND failed', { accountId: account.id, err: String(err) })
    }
    return { ...result, savedToSent }
  }

  // ----- contacts -----------------------------------------------------------------

  /** Self emails of a user (all their accounts), for harvest exclusion. */
  private selfEmails(userId: string): Set<string> {
    return new Set(
      (this.db.prepare('SELECT email FROM mail_accounts WHERE user_id = ?').all(userId) as { email: string }[])
        .map((r) => r.email.trim().toLowerCase()),
    )
  }

  /**
   * Feed the address book from freshly synced envelopes. Best-effort: a contact
   * failure must never fail a folder sync.
   */
  private harvestContacts(account: AccountRow, envelopes: EnvelopeData[]): void {
    try {
      const self = this.selfEmails(account.user_id)
      for (const env of envelopes) {
        this.contacts.recordAddresses(account.user_id, [...env.from, ...env.to, ...env.cc], env.date, self)
      }
    } catch (err) {
      this.log('warn', 'contact harvest failed', { accountId: account.id, err: String(err) })
    }
  }

  listContacts(ctx: AuthContext, opts: { q?: string; limit?: number } = {}): ContactInfo[] {
    this.requireScope(ctx, SCOPES.mailRead)
    const limit = Math.min(200, Math.max(1, opts.limit ?? 100))
    return opts.q && opts.q.trim() ? this.contacts.suggest(ctx.userId, opts.q, limit) : this.contacts.list(ctx.userId, limit)
  }

  suggestContacts(ctx: AuthContext, query: string, limit = 8): ContactInfo[] {
    this.requireScope(ctx, SCOPES.mailRead)
    return this.contacts.suggest(ctx.userId, query, Math.min(50, Math.max(1, limit)))
  }

  createContact(ctx: AuthContext, input: { email: string; name?: string }): ContactInfo {
    this.requireScope(ctx, SCOPES.mailWrite)
    const email = normalizeEmail(input.email ?? '')
    if (!isValidEmail(email)) throw badRequest('A valid email address is required')
    if (this.contacts.getByEmail(ctx.userId, email)) throw conflict('A contact with this email already exists')
    return this.contacts.create(ctx.userId, email, (input.name ?? '').trim())
  }

  updateContact(ctx: AuthContext, id: string, patch: { name?: string; email?: string }): ContactInfo {
    this.requireScope(ctx, SCOPES.mailWrite)
    const existing = this.contacts.get(ctx.userId, id)
    if (!existing) throw notFound('Contact not found')
    const email = patch.email !== undefined ? normalizeEmail(patch.email) : existing.email
    if (!isValidEmail(email)) throw badRequest('A valid email address is required')
    if (email !== existing.email && this.contacts.getByEmail(ctx.userId, email)) throw conflict('A contact with this email already exists')
    const updated = this.contacts.update(ctx.userId, id, { name: patch.name, email })
    if (!updated) throw notFound('Contact not found')
    return updated
  }

  deleteContact(ctx: AuthContext, id: string): void {
    this.requireScope(ctx, SCOPES.mailWrite)
    if (!this.contacts.delete(ctx.userId, id)) throw notFound('Contact not found')
  }

  /**
   * One-time harvest of every message already cached (existing IMAP history) so
   * the address book is populated right after an upgrade without resyncing.
   * Guarded by an app_meta flag so a restart never double-counts.
   */
  backfillContactsOnce(): number {
    const meta = this.db.prepare('SELECT value FROM app_meta WHERE key = ?').get('contacts_backfill')
    if (meta) return 0
    this.db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?)').run('contacts_backfill', new Date().toISOString())
    const accounts = this.db.prepare('SELECT * FROM mail_accounts').all() as AccountRow[]
    const selfCache = new Map<string, Set<string>>()
    const row = this.db.prepare('SELECT from_json, to_json, cc_json, date FROM messages WHERE account_id = ?')
    let harvested = 0
    for (const account of accounts) {
      if (this.closed) return harvested
      let self = selfCache.get(account.user_id)
      if (!self) {
        self = this.selfEmails(account.user_id)
        selfCache.set(account.user_id, self)
      }
      for (const m of row.all(account.id) as { from_json: string; to_json: string; cc_json: string; date: number | null }[]) {
        const addresses = [m.from_json, m.to_json, m.cc_json].flatMap((json) => parseAddressJson(json))
        harvested += this.contacts.recordAddresses(account.user_id, addresses, m.date, self)
      }
    }
    this.log('info', 'contacts backfilled from cached history', { messagesAccounts: accounts.length, addresses: harvested })
    return harvested
  }

  // ----- drafts --------------------------------------------------------------------

  /**
   * Save a real IMAP draft: the message is APPENDed to the account's Drafts
   * folder with the \Draft flag, so it is visible and editable in HermodMail or
   * any other mail client. Nothing is ever sent. Requires mail:write (sending
   * stays behind mail:send).
   */
  async saveDraft(ctx: AuthContext, input: SaveDraftInput): Promise<SaveDraftResult> {
    this.requireScope(ctx, SCOPES.mailWrite)
    const account = this.getOwnedAccount(ctx, input.accountId)
    const to = cleanAddresses(input.to)
    const cc = cleanAddresses(input.cc)
    const bcc = cleanAddresses(input.bcc)
    const subject = (input.subject ?? '').trim()
    let text = input.text?.trim() ?? ''
    if (!text && input.html) text = emailHtmlToText(input.html)

    // Locate the Drafts folder, creating a standard one when the server has none.
    let drafts = this.findSpecialFolder(account.id, 'drafts')
    if (!drafts) {
      const transport = await this.acquire(account)
      await transport.createFolder('Drafts')
      await this.refreshFolderList(account.id)
      drafts = this.findSpecialFolder(account.id, 'drafts')
    }
    if (!drafts) throw new AppError('mail_protocol', 'No Drafts folder is available on this mail server')

    const messageId = `<${randomUUID()}@hermodmail.local>`
    const { buildRawMail } = await import('./compose.js')
    const raw = await buildRawMail({
      from: { name: account.name, email: account.email },
      to,
      cc,
      bcc,
      subject,
      text,
      html: input.html,
      inReplyTo: input.inReplyTo,
      references: input.references,
      messageId,
    })
    const transport = await this.acquire(account)
    const appendedUid = await transport.appendMessage(drafts.path, raw, ['\\Draft', '\\Seen'])
    try {
      await this.syncFolderInternal(account.id, drafts.path)
    } catch (err) {
      this.log('warn', 'post-draft sync failed', { accountId: account.id, err: String(err) })
    }
    // Cached row (and thus uid/id) may be unavailable when the sync failed.
    const row = (appendedUid ? this.store.getMessageRow(drafts.id, appendedUid) : undefined)
      ?? this.store.findRowByMessageId(drafts.id, messageId)
    return { ok: true, folder: drafts.path, uid: row?.uid ?? appendedUid ?? null, id: row?.id ?? null }
  }

  // ----- user settings -------------------------------------------------------------

  /** Polling interval (ms) the web client should use; 0 = manual only. */
  getRefreshIntervalMs(ctx: AuthContext): number {
    const row = this.db
      .prepare('SELECT refresh_interval_ms FROM user_settings WHERE user_id = ?')
      .get(ctx.userId) as { refresh_interval_ms: number } | undefined
    return row?.refresh_interval_ms ?? DEFAULT_REFRESH_INTERVAL_MS
  }

  setRefreshIntervalMs(ctx: AuthContext, ms: number): number {
    if (!(REFRESH_INTERVALS_MS as readonly number[]).includes(ms)) {
      throw badRequest('Unsupported refresh interval')
    }
    this.db
      .prepare(
        `INSERT INTO user_settings (user_id, refresh_interval_ms, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET refresh_interval_ms = excluded.refresh_interval_ms, updated_at = excluded.updated_at`,
      )
      .run(ctx.userId, ms, Date.now())
    return ms
  }

  /** UI language preference; '' = unset (client falls back to its own detection). */
  getUserLocale(ctx: AuthContext): string {
    const row = this.db
      .prepare('SELECT locale FROM user_settings WHERE user_id = ?')
      .get(ctx.userId) as { locale: string } | undefined
    return row?.locale ?? ''
  }

  setUserLocale(ctx: AuthContext, locale: string): string {
    if (!isUiLocale(locale)) throw badRequest(`Unsupported locale (supported: ${UI_LOCALES.join(', ')})`)
    this.db
      .prepare(
        `INSERT INTO user_settings (user_id, locale, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET locale = excluded.locale, updated_at = excluded.updated_at`,
      )
      .run(ctx.userId, locale, Date.now())
    return locale
  }

  // ----- lifecycle -----------------------------------------------------------------

  close(): void {
    this.closed = true
    if (this.sweeper) clearInterval(this.sweeper)
    for (const [, entry] of this.pool) void entry.transport.close().catch(() => {})
    this.pool.clear()
  }
}

function cleanAddresses(list: Address[] | undefined): Address[] {
  return (list ?? [])
    .map((a) => ({ name: a.name?.trim() || undefined, email: a.email.trim() }))
    .filter((a) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.email))
}

/** Parse a stored JSON address array defensively (harvest must never throw). */
function parseAddressJson(json: string): Address[] {
  try {
    const parsed = JSON.parse(json)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((a): a is Address => !!a && typeof (a as Address).email === 'string')
  } catch {
    return []
  }
}

function toAccountInfo(row: AccountRow): MailAccountInfo {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    imap: { host: row.imap_host, port: row.imap_port, tls: row.imap_tls, user: row.imap_user },
    smtp: { host: row.smtp_host, port: row.smtp_port, tls: row.smtp_tls, user: row.smtp_user },
    createdAt: row.created_at,
    lastSyncAt: row.last_sync_at,
  }
}

export function messageToMarkdown(m: MessageDetail): string {
  const lines: string[] = []
  lines.push(`# ${m.subject || '(no subject)'}`)
  lines.push('')
  const from = m.from.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(', ')
  lines.push(`- **From:** ${from || 'unknown'}`)
  if (m.to.length) lines.push(`- **To:** ${m.to.map((a) => a.name || a.email).join(', ')}`)
  if (m.cc.length) lines.push(`- **Cc:** ${m.cc.map((a) => a.name || a.email).join(', ')}`)
  lines.push(`- **Date:** ${m.date ? new Date(m.date).toISOString() : 'unknown'}`)
  lines.push(`- **Folder:** ${m.folderPath}`)
  if (m.attachments.length) {
    lines.push(`- **Attachments:** ${m.attachments.map((a) => `${a.filename} (${a.contentType}, ${a.size} B)`).join(', ')}`)
  }
  lines.push('')
  lines.push(m.bodyText?.trim() || '(empty message)')
  if (m.summary) {
    lines.push('')
    lines.push('> **AI summary:** ' + m.summary)
  }
  return lines.join('\n')
}

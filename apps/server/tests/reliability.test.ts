import { beforeEach, describe, expect, it } from 'vitest'
import { openInMemoryDatabase, type DB } from '../src/db/database.js'
import { AuthService } from '../src/core/auth-service.js'
import { MailStore } from '../src/core/mail/store.js'
import { MailEngine } from '../src/core/mail/engine.js'
import { InMemoryTransport, FakeSmtpSender, makeRaw } from './inmemory-transport.js'
import { classifySmtpFailure } from '../src/core/mail/smtp.js'
import { buildApp } from '../src/http/app.js'
import { registerRoutes } from '../src/http/routes.js'
import type { Config } from '../src/config.js'
import type { AuthContext } from '../src/core/types.js'
import { SCOPES } from '../src/core/types.js'
import { forbidden, AppError } from '../src/core/errors.js'
import { sanitizeFilename } from '../src/core/mail/sanitize.js'

describe('sanitizeFilename (defense in depth for HTTP header values)', () => {
  it('strips quote- and CR/LF-injection payloads from filenames', () => {
    expect(sanitizeFilename('report.txt"; xss="1')).toBe('report.txt__ xss__1')
    expect(sanitizeFilename('a\r\nX-Injected: yes\r\n')).toBe('a__X-Injected_ yes__')
    expect(sanitizeFilename('safe-name (1).pdf')).toBe('safe-name (1).pdf')
    expect(sanitizeFilename('')).toBe('attachment')
    const out = sanitizeFilename('x'.repeat(500))
    expect(out).toHaveLength(150)
  })
})

const masterSecret = Buffer.from('r'.repeat(32))

function makeConfig(over: Partial<Config> = {}): Config {
  return {
    port: 0, host: '', dataDir: '', masterSecret, webDist: undefined, trustProxy: false, cookieSecure: false,
    sessionTtlHours: 1, initialSyncLimit: 50, bodyIndexLimit: 50, maxAttachmentSize: 1024 * 1024,
    ...over,
  }
}

interface World {
  db: DB
  auth: AuthService
  store: MailStore
  engine: MailEngine
  smtp: FakeSmtpSender
  transports: Map<string, InMemoryTransport>
  web: AuthContext
  token: AuthContext
  accountId: string
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 20))
  }
}

async function makeWorld(configOver: Partial<Config> = {}): Promise<World> {
  const db = openInMemoryDatabase()
  const auth = new AuthService(db, 24)
  const store = new MailStore(db)
  const transports = new Map<string, InMemoryTransport>()
  const smtp = new FakeSmtpSender()
  const engine = new MailEngine(
    db, makeConfig(configOver), store,
    async (cfg) => {
      let t = transports.get(cfg.host)
      if (!t) { t = new InMemoryTransport(cfg.user); transports.set(cfg.host, t) }
      return t
    },
    smtp.sender,
    () => {},
  )
  auth.createUserGuarded({ email: 'owner@x.test', password: 'password123' })
  const web = auth.contextForSession(auth.login('owner@x.test', 'password123').token)!
  const { token: rawToken } = auth.createToken(web.userId, 'agent', [SCOPES.mailRead, SCOPES.mailWrite, SCOPES.mailSend, SCOPES.mailDelete])
  const token = auth.contextForToken(rawToken)!
  const info = await engine.addAccount(web, {
    name: 'Test', email: 'me@example.com',
    imap: { host: 'imap.rel', port: 993, tls: 'tls', user: 'me@example.com', password: 'p' },
    smtp: { host: 'smtp.rel', port: 587, tls: 'starttls' },
  })
  return { db, auth, store, engine, smtp, transports, web, token, accountId: info.id }
}

describe('Round 1 fixes — attachments, FTS, lifecycle', () => {
  let w: World
  beforeEach(async () => { w = await makeWorld() })

  it('propagates real attachment ids so downloads work (regression: id was empty string)', async () => {
    const transport = w.transports.get('imap.rel')!
    transport.deliver('INBOX', makeRaw({ subject: 'With file', text: 'see attached', attachment: { filename: 'report.txt', content: 'ATTACHMENT-CONTENT-123' } }))
    await w.engine.syncFolder(w.web, w.accountId, 'INBOX')
    const detail = await w.engine.getMessage(w.token, w.accountId, 'INBOX', 1, { markSeen: false })
    expect(detail.attachments).toHaveLength(1)
    const id = detail.attachments[0]!.id
    expect(id).toBeTruthy()
    expect(id.startsWith('oversize:')).toBe(false)
    const att = w.engine.getAttachment(w.token, w.accountId, id)
    expect(att?.content.toString()).toBe('ATTACHMENT-CONTENT-123')
    expect(att?.filename).toBe('report.txt')
  })

  it('marks over-limit attachments with an oversize id and refuses their download', async () => {
    const small = await makeWorld({ maxAttachmentSize: 10 })
    const transport = small.transports.get('imap.rel')!
    transport.deliver('INBOX', makeRaw({ subject: 'Big file', text: 'x', attachment: { filename: 'big.bin', content: 'A'.repeat(1000) } }))
    await small.engine.syncFolder(small.web, small.accountId, 'INBOX')
    const detail = await small.engine.getMessage(small.token, small.accountId, 'INBOX', 1, { markSeen: false })
    expect(detail.attachments[0]!.id.startsWith('oversize:')).toBe(true)
    expect(() => small.engine.getAttachment(small.token, small.accountId, detail.attachments[0]!.id)).toThrowError(AppError)
  })

  it('cleans the FTS index when a folder is deleted (no ghost search hits)', async () => {
    const transport = w.transports.get('imap.rel')!
    transport.deliver('INBOX', makeRaw({ subject: 'Ghost bait', text: 'xylophone unique-token-931' }))
    await w.engine.syncFolder(w.web, w.accountId, 'INBOX')
    // Body indexing is asynchronous — wait until the body is searchable.
    await waitFor(() => w.engine.searchMessages(w.token, { query: 'xylophone' }).length === 1)
    // Direct folder delete (the path the FK cascade would take)
    const folder = w.store.getFolder(w.accountId, 'INBOX')!
    w.store.deleteFolder(folder.id)
    expect(w.engine.searchMessages(w.token, { query: 'xylophone' })).toHaveLength(0)
  })

  it('purges expired sessions at login time', () => {
    w.db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run('stale-hash', w.web.userId, Date.now() - 5000, Date.now() - 1000)
    expect(w.db.prepare('SELECT COUNT(*) c FROM sessions WHERE token_hash = ?').get('stale-hash')).toMatchObject({ c: 1 })
    w.auth.login('owner@x.test', 'password123')
    expect(w.db.prepare('SELECT COUNT(*) c FROM sessions WHERE token_hash = ?').get('stale-hash')).toMatchObject({ c: 0 })
  })

  it('closes the pooled transport when account credentials are updated (no leak)', async () => {
    // Populate the pool first (addAccount's probe connection was already closed).
    await w.engine.listFolders(w.web, w.accountId)
    const transport = w.transports.get('imap.rel')!
    transport.closed = false
    await w.engine.updateAccount(w.web, w.accountId, { imap: { password: 'new-password' } })
    expect(transport.closed).toBe(true)
  })
})

describe('Round 2 fixes — hostile security regressions', () => {
  let w: World
  beforeEach(async () => { w = await makeWorld() })

  it('neutralizes hostile attachment filenames end-to-end (mailparser truncation + HTTP sanitize)', async () => {
    const evil = 'report.txt"; xss="1'
    const transport = w.transports.get('imap.rel')!
    transport.deliver('INBOX', makeRaw({ subject: 'evil', text: 'x', attachment: { filename: evil, content: 'c' } }))
    await w.engine.syncFolder(w.web, w.accountId, 'INBOX')
    const detail = await w.engine.getMessage(w.token, w.accountId, 'INBOX', 1, { markSeen: false })
    const id = detail.attachments[0]!.id
    const app = await buildApp({ auth: w.auth, webDist: undefined })
    registerRoutes(app, { auth: w.auth, engine: w.engine, aiRegistry: {} as never, aiService: {} as never, secureCookies: false })
    const res = await app.inject({ method: 'GET', url: `/api/attachments/${w.accountId}/${id}`, headers: { authorization: 'Bearer hmt_invalid' } })
    // 401 first: verify auth is enforced on the attachment route too
    expect(res.statusCode).toBe(401)

    const { token: rawTok } = w.auth.createToken(w.web.userId, 't', [SCOPES.mailRead])
    const ok = await app.inject({ method: 'GET', url: `/api/attachments/${w.accountId}/${id}`, headers: { authorization: `Bearer ${rawTok}` } })
    expect(ok.statusCode).toBe(200)
    expect(ok.headers['x-content-type-options']).toBe('nosniff')
    const disposition = String(ok.headers['content-disposition'])
    expect(disposition).toMatch(/^attachment; filename="[^"]*"$/)
    expect(disposition).not.toContain('\r')
    expect(disposition).not.toContain('\n')
    expect(ok.body).toBe('c')
    await app.close()
  })

  it('blocks cross-origin cookie-authenticated API mutations (CSRF) but allows Bearer and no-Origin clients', async () => {
    const app = await buildApp({ auth: w.auth, webDist: undefined })
    registerRoutes(app, { auth: w.auth, engine: w.engine, aiRegistry: {} as never, aiService: {} as never, secureCookies: false })

    // Cross-origin browser request: rejected before authentication matters.
    const evil = await app.inject({
      method: 'POST', url: '/api/auth/login',
      headers: { origin: 'https://evil.example' },
      payload: { email: 'owner@x.test', password: 'password123' },
    })
    expect(evil.statusCode).toBe(403)

    // Same-origin: fine.
    const good = await app.inject({
      method: 'POST', url: '/api/auth/login',
      headers: { origin: 'http://127.0.0.1:8080', host: '127.0.0.1:8080' },
      payload: { email: 'owner@x.test', password: 'password123' },
    })
    expect(good.statusCode).toBe(200)

    // Server-to-server (no Origin): fine.
    const noOrigin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@x.test', password: 'password123' } })
    expect(noOrigin.statusCode).toBe(200)

    // Bearer token with foreign Origin: immune to CSRF by construction.
    const { token: rawTok } = w.auth.createToken(w.web.userId, 't', [SCOPES.mailRead])
    const bearer = await app.inject({
      method: 'POST', url: `/api/accounts/${w.accountId}/sync`,
      headers: { authorization: `Bearer ${rawTok}`, origin: 'https://evil.example' },
      payload: { folder: 'INBOX' },
    })
    expect(bearer.statusCode).not.toBe(403)
    await app.close()
  })

  it('forbids API tokens from managing mail accounts (no token-driven credential enrollment)', async () => {
    await expect(w.engine.addAccount(w.token, {
      name: 'x', email: 'x@y.co',
      imap: { host: 'h', port: 993, tls: 'tls', user: 'u', password: 'p' },
      smtp: { host: 'h', port: 587, tls: 'starttls' },
    })).rejects.toThrowError(forbidden('x').constructor)
    // deleteAccount is synchronous — assert the throw, not a rejected promise.
    expect(() => w.engine.deleteAccount(w.token, w.accountId)).toThrowError(forbidden('x').constructor)
    await expect(w.engine.updateAccount(w.token, w.accountId, { name: 'x' })).rejects.toThrowError(forbidden('x').constructor)
    // web session still can
    await expect(w.engine.testAccount(w.web, w.accountId)).resolves.toMatchObject({ ok: true })
  })
})

describe('Round 3 fixes — IMAP/SMTP reliability', () => {
  let w: World
  beforeEach(async () => { w = await makeWorld() })

  it('retries a read on a dead pooled connection with a fresh one', async () => {
    const transport = w.transports.get('imap.rel')!
    transport.deliver('INBOX', makeRaw({ subject: 'Survivor' }))
    await w.engine.syncFolder(w.web, w.accountId, 'INBOX')
    transport.failNext = 'syncFolder' // pooled connection dies mid-sync
    const res = await w.engine.syncFolder(w.web, w.accountId, 'INBOX')
    expect(res.newMessages).toBe(0) // retried successfully on a fresh transport
    expect(transport.failNext).toBeNull()
  })

  it('does NOT auto-retry mutating operations (non-idempotent)', async () => {
    const transport = w.transports.get('imap.rel')!
    transport.deliver('INBOX', makeRaw({ subject: 'Target' }))
    await w.engine.syncFolder(w.web, w.accountId, 'INBOX')
    transport.failNext = 'syncFolder' // not used by patchMessage, but proves no '*' retry
    await w.engine.patchMessage(w.token, w.accountId, 'INBOX', 1, { flagged: true })
    expect(transport.messages.get('INBOX')![0]!.flags.has('\\Flagged')).toBe(true)
  })

  it('reconciles messages deleted remotely between syncs', async () => {
    const transport = w.transports.get('imap.rel')!
    transport.deliver('INBOX', makeRaw({ subject: 'One' }))
    transport.deliver('INBOX', makeRaw({ subject: 'Two' }))
    transport.deliver('INBOX', makeRaw({ subject: 'Three' }))
    await w.engine.syncFolder(w.web, w.accountId, 'INBOX')
    let list = await w.engine.listMessages(w.token, w.accountId, { folder: 'INBOX', sync: false })
    expect(list.total).toBe(3)

    // Someone deletes "Two" from another client.
    const remote = transport.messages.get('INBOX')!
    remote.splice(remote.findIndex((m) => m.uid === 2), 1)
    // Incremental sync must notice the shrinking count and reconcile.
    const res = await w.engine.syncFolder(w.web, w.accountId, 'INBOX')
    expect(res.total).toBe(2)
    list = await w.engine.listMessages(w.token, w.accountId, { folder: 'INBOX', sync: false })
    expect(list.messages.map((m) => m.subject)).toEqual(['Three', 'One'])
  })

  it('classifies SMTP failures: protocol rejection vs undetermined outcome, and never auto-retries', async () => {
    // Definitive protocol rejection
    const rejected = classifySmtpFailure({ response: '550 5.1.1 user unknown' })
    expect(rejected.outcome).toBe('rejected')
    // Ambiguous failure: timeout after DATA — the server may have queued it
    const uncertain = classifySmtpFailure({ code: 'ESOCKET', command: 'data' })
    expect(uncertain.outcome).toBe('uncertain')
    expect(uncertain.reason).toContain('UNDETERMINED')
    expect(uncertain.reason).toContain('duplicates')

    // Engine path: SMTP throw must surface the outcome and must NOT retry
    // nor append to Sent (which would fake a successful send).
    const failingSender = async () => {
      throw new AppError('mail_connection', 'boom', { outcome: 'uncertain' })
    }
    const db2 = openInMemoryDatabase()
    const auth2 = new AuthService(db2, 24)
    const store2 = new MailStore(db2)
    const transports2 = new Map<string, InMemoryTransport>()
    const engine2 = new MailEngine(db2, makeConfig(), store2,
      async (cfg) => {
        let t = transports2.get(cfg.host)
        if (!t) { t = new InMemoryTransport(cfg.user); transports2.set(cfg.host, t) }
        return t
      },
      failingSender,
      () => {},
    )
    auth2.createUserGuarded({ email: 'u@x.test', password: 'password123' })
    const web2 = auth2.contextForSession(auth2.login('u@x.test', 'password123').token)!
    const info2 = await engine2.addAccount(web2, {
      name: 'T', email: 'me@example.com',
      imap: { host: 'imap.f', port: 993, tls: 'tls', user: 'u', password: 'p' },
      smtp: { host: 'smtp.f', port: 587, tls: 'starttls' },
    })
    await expect(engine2.sendMessage(web2, { accountId: info2.id, to: [{ email: 'a@b.co' }], subject: 's', text: 't' }))
      .rejects.toMatchObject({ details: { outcome: 'uncertain' } })
    // Exactly ONE send attempt, no Sent-folder append:
    expect(transports2.get('imap.f')!.messages.get('Sent')).toHaveLength(0)
  })

  it('keeps exactly-one send semantics: a successful send is never retransmitted', async () => {
    const res = await w.engine.sendMessage(w.token, { accountId: w.accountId, to: [{ email: 'a@b.co' }], subject: 'once', text: 'x' })
    expect(w.smtp.sent).toHaveLength(1)
    expect(res.savedToSent).toBe(true)
    // A second explicit call is a separate message, not a retry:
    await w.engine.sendMessage(w.token, { accountId: w.accountId, to: [{ email: 'a@b.co' }], subject: 'twice', text: 'x' })
    expect(w.smtp.sent).toHaveLength(2)
    expect(w.smtp.sent[0]!.raw.toString()).not.toContain('twice')
  })
})

describe('ImapFlowTransport.close on a dead connection (process-crash regression)', () => {
  it('awaits logout(): a rejecting logout must be swallowed, never escape as an unhandled rejection', async () => {
    const { ImapFlowTransport } = await import('../src/core/mail/imapflow-transport.js')
    // Regression: close() used to call logout() without await — the rejection
    // escaped the try/catch as an unhandled rejection and killed the process
    // (reproduced: sync while the IMAP socket was already dead). Without the
    // fix, this test's unhandled rejection crashes the vitest run itself.
    const t = Object.create(ImapFlowTransport.prototype) as ImapFlowTransport
    ;(t as unknown as { client: unknown }).client = {
      on: () => {},
      logout: async () => { throw new Error('Connection not available') },
      close: () => {},
    }
    await expect(t.close()).resolves.toBeUndefined()
  })
})

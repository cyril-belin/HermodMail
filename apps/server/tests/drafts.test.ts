import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openInMemoryDatabase, type DB } from '../src/db/database.js'
import { AuthService } from '../src/core/auth-service.js'
import { MailStore } from '../src/core/mail/store.js'
import { MailEngine } from '../src/core/mail/engine.js'
import type { AuthContext } from '../src/core/types.js'
import { SCOPES } from '../src/core/types.js'
import type { Config } from '../src/config.js'
import { InMemoryTransport, FakeSmtpSender } from './inmemory-transport.js'
import { buildApp } from '../src/http/app.js'
import { registerRoutes } from '../src/http/routes.js'
import { registerMcp } from '../src/mcp/server.js'
import type { Server } from 'node:http'

const masterSecret = Buffer.from('m'.repeat(32))

/**
 * Real IMAP drafts: saveDraft APPENDs a \Draft message to the Drafts folder
 * (creating it when the server has none), nothing is ever sent through SMTP,
 * and the draft lands in the local cache so HermodMail and MCP can see it.
 */
describe('Drafts', () => {
  let db: DB
  let engine: MailEngine
  let web: AuthContext
  let readOnlyWeb: AuthContext
  let tokenWrite: string
  let tokenRead: string
  let transport: InMemoryTransport
  let smtp: FakeSmtpSender
  let accountId: string
  let app: import('fastify').FastifyInstance
  let baseUrl: string
  let server: Server | undefined

  beforeAll(async () => {
    db = openInMemoryDatabase()
    const auth = new AuthService(db, 24)
    const store = new MailStore(db)
    const transports = new Map<string, InMemoryTransport>()
    transport = new InMemoryTransport('me@drafts.test')
    transports.set('imap.drafts', transport)
    smtp = new FakeSmtpSender()
    engine = new MailEngine(
      db,
      { port: 0, host: '', dataDir: '', masterSecret, webDist: undefined, trustProxy: false, sessionTtlHours: 1, initialSyncLimit: 50, bodyIndexLimit: 50, maxAttachmentSize: 100_000 } satisfies Config,
      store,
      async (cfg) => {
        let t = transports.get(cfg.host)
        if (!t) { t = new InMemoryTransport(cfg.user); transports.set(cfg.host, t) }
        return t
      },
      smtp.sender,
      () => {},
    )
    auth.createUserGuarded({ email: 'u@drafts.test', password: 'password123' })
    web = auth.contextForSession(auth.login('u@drafts.test', 'password123').token)!
    readOnlyWeb = { ...web, kind: 'token', scopes: new Set([SCOPES.mailRead]) }
    tokenWrite = auth.createToken(web.userId, 'agent', Object.values(SCOPES)).token
    tokenRead = auth.createToken(web.userId, 'ro', [SCOPES.mailRead]).token

    accountId = (await engine.addAccount(web, {
      name: 'Me', email: 'me@drafts.test',
      imap: { host: 'imap.drafts', port: 993, tls: 'tls', user: 'me@drafts.test', password: 'p' },
      smtp: { host: 'smtp.drafts', port: 587, tls: 'starttls' },
    })).id

    app = await buildApp({ auth, webDist: undefined })
    registerRoutes(app, { auth, engine, aiRegistry: {} as never, aiService: {} as never, secureCookies: false })
    registerMcp(app, { auth, engine, aiService: {} as never, keepAliveMs: 100 })
    await app.listen({ port: 0, host: '127.0.0.1' })
    const address = app.server.address()
    if (!address || typeof address === 'string') throw new Error('no port')
    baseUrl = `http://127.0.0.1:${address.port}`
    server = app.server
  })

  afterAll(async () => {
    engine.close()
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('creates the Drafts folder when missing and APPENDs a \\Draft message — nothing is sent', async () => {
    expect(transport.folders.has('Drafts')).toBe(false)
    const res = await engine.saveDraft(web, {
      accountId,
      to: [{ name: 'Alice', email: 'alice@example.com' }],
      subject: 'My first draft',
      text: 'Hello from a draft',
    })
    expect(res.ok).toBe(true)
    expect(res.folder).toBe('Drafts')
    expect(typeof res.uid).toBe('number')
    expect(res.id).toBeTruthy()
    // Drafts folder created server-side, message stored with the \Draft flag.
    expect(transport.folders.has('Drafts')).toBe(true)
    const stored = transport.messages.get('Drafts')!.find((m) => m.uid === res.uid)!
    expect(stored.flags.has('\\Draft')).toBe(true)
    expect(stored.raw.toString('utf8')).toContain('Subject: My first draft')
    expect(stored.raw.toString('utf8')).toContain('To: Alice <alice@example.com>')
    expect(stored.raw.toString('utf8')).toContain('Hello from a draft')
    // Absolutely no SMTP activity.
    expect(smtp.sent).toHaveLength(0)
  })

  it('keeps conversation threading headers (In-Reply-To / References)', async () => {
    await engine.saveDraft(web, {
      accountId,
      to: [{ email: 'alice@example.com' }],
      subject: 'Re: thread',
      text: 'reply draft',
      inReplyTo: 'orig@example.com',
      references: ['a@example.com', 'orig@example.com'],
    })
    const stored = transport.messages.get('Drafts')!.at(-1)!
    const raw = stored.raw.toString('utf8')
    expect(raw).toContain('In-Reply-To: <orig@example.com>')
    expect(raw).toContain('References: <a@example.com> <orig@example.com>')
  })

  it('derives a text body from an html-only draft', async () => {
    await engine.saveDraft(web, {
      accountId,
      to: [{ email: 'alice@example.com' }],
      subject: 'html draft',
      html: '<p>Rich <b>body</b></p>',
    })
    const stored = transport.messages.get('Drafts')!.at(-1)!
    expect(stored.raw.toString('utf8')).toContain('Rich body')
  })

  it('lands in the local cache and reads back through the engine', async () => {
    const res = await engine.saveDraft(web, {
      accountId,
      to: [{ email: 'bob@example.com' }],
      subject: 'readable draft',
      text: 'cache me',
    })
    const detail = await engine.getMessage(web, accountId, 'Drafts', res.uid!, { markSeen: false })
    expect(detail.subject).toBe('readable draft')
    expect(detail.bodyText).toContain('cache me')
    expect(detail.draft).toBe(true)
  })

  it('requires the mail:write scope', async () => {
    await expect(engine.saveDraft(readOnlyWeb, { accountId, to: [{ email: 'x@y.co' }], subject: 'nope', text: 'x' }))
      .rejects.toThrow(/mail:write/)
  })

  it('HTTP: POST /api/drafts saves a draft; read-only token gets 403', async () => {
    const ok = await fetch(`${baseUrl}/api/drafts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenWrite}` },
      body: JSON.stringify({ accountId, to: [{ email: 'http@example.com' }], subject: 'via http', text: 'body' }),
    })
    expect(ok.status).toBe(200)
    const body = (await ok.json()) as { folder: string; uid: number }
    expect(body.folder).toBe('Drafts')

    const denied = await fetch(`${baseUrl}/api/drafts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenRead}` },
      body: JSON.stringify({ accountId, to: [{ email: 'http@example.com' }], subject: 'nope', text: 'x' }),
    })
    expect(denied.status).toBe(403)
  })

  describe('MCP create_draft over HTTP', () => {
    let sessionId: string

    async function rpc(method: string, params: object | undefined, token: string) {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
      }
      if (sessionId) headers['mcp-session-id'] = sessionId
      const res = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method, ...(params !== undefined ? { params } : {}) }),
      })
      const sid = res.headers.get('mcp-session-id')
      if (sid) sessionId = sid
      const contentType = res.headers.get('content-type') ?? ''
      const raw = await res.text()
      let body: Record<string, unknown>
      if (contentType.includes('text/event-stream')) {
        const dataLines = raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).filter(Boolean)
        body = dataLines.length ? (JSON.parse(dataLines[dataLines.length - 1]!) as Record<string, unknown>) : {}
      } else {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
      }
      return { status: res.status, body }
    }

    const resultText = (body: Record<string, unknown>): string => {
      const result = body.result as { content?: { text?: string }[]; isError?: boolean } | undefined
      return result?.content?.map((c) => c.text).join(' ') ?? ''
    }

    it('exposes create_draft and saves a real draft without sending', async () => {
      sessionId = ''
      await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'draft-client', version: '0' } }, tokenWrite)
      await rpc('notifications/initialized', undefined, tokenWrite)

      const tools = await rpc('tools/list', {}, tokenWrite)
      const names = (((tools.body as { result?: { tools?: { name: string }[] } }).result?.tools) ?? []).map((t) => t.name)
      expect(names).toContain('create_draft')
      expect(names).toContain('draft_reply')

      const call = await rpc('tools/call', {
        name: 'create_draft',
        arguments: { to: [{ email: 'agent@example.com' }], subject: 'agent draft', text: 'written by an agent' },
      }, tokenWrite)
      const text = resultText(call.body)
      expect((call.body as { result?: { isError?: boolean } }).result?.isError).toBeFalsy()
      const parsed = JSON.parse(text) as { folder: string; uid: number; ok: boolean }
      expect(parsed.ok).toBe(true)
      expect(parsed.folder).toBe('Drafts')

      // The draft is visible through the same session (list + read).
      const list = await rpc('tools/call', {
        name: 'list_messages',
        arguments: { folder: 'Drafts', sync: false },
      }, tokenWrite)
      const messages = JSON.parse(resultText(list.body)) as { messages: { subject: string; uid: number }[] }
      expect(messages.messages.some((m) => m.subject === 'agent draft' && m.uid === parsed.uid)).toBe(true)

      // And nothing was ever sent through SMTP.
      expect(smtp.sent).toHaveLength(0)
    })

    it('a read-only token cannot create drafts', async () => {
      sessionId = ''
      await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ro-client', version: '0' } }, tokenRead)
      await rpc('notifications/initialized', undefined, tokenRead)
      const call = await rpc('tools/call', {
        name: 'create_draft',
        arguments: { to: [{ email: 'agent@example.com' }], subject: 'nope', text: 'x' },
      }, tokenRead)
      const result = (call.body as { result?: { isError?: boolean; content?: { text?: string }[] } }).result
      expect(result?.isError).toBe(true)
      expect(result?.content?.map((c) => c.text).join(' ')).toContain('mail:write')
    })
  })
})

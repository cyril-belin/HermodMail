import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openInMemoryDatabase, type DB } from '../src/db/database.js'
import { AuthService } from '../src/core/auth-service.js'
import { MailStore } from '../src/core/mail/store.js'
import { MailEngine } from '../src/core/mail/engine.js'
import { AiProviderRegistry } from '../src/core/ai/provider.js'
import { AiService } from '../src/core/ai/service.js'
import { InMemoryTransport, FakeSmtpSender } from './inmemory-transport.js'
import { buildApp } from '../src/http/app.js'
import { registerRoutes } from '../src/http/routes.js'
import { registerMcp } from '../src/mcp/server.js'
import type { Config } from '../src/config.js'
import type { Server } from 'node:http'
import { SCOPES } from '../src/core/types.js'

const masterSecret = Buffer.from('m'.repeat(32))

/**
 * Real MCP-over-HTTP test: boots the actual Fastify app (routes + MCP) on an
 * ephemeral port and speaks JSON-RPC like a real MCP client would.
 */
describe('MCP server over HTTP', () => {
  let server: Server
  let baseUrl: string
  let db: DB
  let adminToken: string
  let readOnlyToken: string
  let accountId: string

  beforeAll(async () => {
    db = openInMemoryDatabase()
    const auth = new AuthService(db, 24)
    const store = new MailStore(db)
    const transports = new Map<string, InMemoryTransport>()
    const engine = new MailEngine(
      db,
      { port: 0, host: '', dataDir: '', masterSecret, webDist: undefined, trustProxy: false, sessionTtlHours: 1, initialSyncLimit: 20, bodyIndexLimit: 20, maxAttachmentSize: 100_000 } satisfies Config,
      store,
      async (cfg) => {
        let t = transports.get(cfg.host)
        if (!t) { t = new InMemoryTransport(cfg.user); transports.set(cfg.host, t) }
        return t
      },
      new FakeSmtpSender().sender,
      () => {},
    )
    const aiRegistry = new AiProviderRegistry(db, masterSecret)
    const aiService = new AiService(aiRegistry, store, engine)

    auth.createUserGuarded({ email: 'admin@x.test', password: 'password123' })
    const web = auth.contextForSession(auth.login('admin@x.test', 'password123').token)!
    adminToken = auth.createToken(web.userId, 'full-agent', Object.values(SCOPES)).token
    readOnlyToken = auth.createToken(web.userId, 'ro-agent', [SCOPES.mailRead]).token

    const info = await engine.addAccount(web, {
      name: 'Test', email: 'me@example.com',
      imap: { host: 'imap.mcp', port: 993, tls: 'tls', user: 'me@example.com', password: 'p' },
      smtp: { host: 'smtp.mcp', port: 587, tls: 'starttls' },
    })
    accountId = info.id
    const transport = transports.get('imap.mcp')!
    transport.deliver('INBOX', Buffer.from(
      `From: Alice <alice@example.com>\r\nTo: me@example.com\r\nSubject: MCP hello\r\nDate: ${new Date().toUTCString()}\r\nMessage-ID: <mcp1@example.com>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello from MCP test.\r\n`,
    ))
    await engine.syncFolder(web, accountId, 'INBOX')

    const app = await buildApp({ auth, webDist: undefined })
    registerRoutes(app, { auth, engine, aiRegistry, aiService, secureCookies: false })
    registerMcp(app, { auth, engine, aiService, keepAliveMs: 100 })
    await app.listen({ port: 0, host: '127.0.0.1' })
    const address = app.server.address()
    if (!address || typeof address === 'string') throw new Error('no port')
    baseUrl = `http://127.0.0.1:${address.port}`
    server = app.server
  })

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  let sessionId: string | undefined

  /**
   * Speaks JSON-RPC like a real MCP client. In streamable-HTTP SSE mode the
   * JSON-RPC reply arrives as `data:` events; error/auth replies stay plain
   * JSON and notifications come back as an empty 202.
   */
  async function rpc(method: string, params: object | undefined, token: string, opts: { session?: string } = {}) {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    }
    if (opts.session) headers['mcp-session-id'] = opts.session
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
    return { status: res.status, body, sessionId: sid, contentType }
  }

  it('rejects requests without a Bearer token', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }),
    })
    expect(res.status).toBe(401)
  })

  it('initializes a session and lists accounts via tools/call', async () => {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-client', version: '0.0.1' } }, adminToken)
    expect(init.status).toBe(200)
    const sid = init.sessionId
    expect(sid).toBeTruthy()
    await rpc('notifications/initialized', undefined, adminToken, { session: sid! })

    const list = await rpc('tools/list', {}, adminToken, { session: sid! })
    const tools = ((list.body as { result?: { tools?: { name: string }[] } }).result?.tools ?? []).map((t) => t.name)
    expect(tools).toEqual(expect.arrayContaining(['list_accounts', 'list_messages', 'get_message', 'send_message', 'delete_message', 'summarize_message', 'export_markdown']))

    const call = await rpc('tools/call', { name: 'list_accounts', arguments: {} }, adminToken, { session: sid! })
    const text = (call.body as { result?: { content?: { text?: string }[] } }).result?.content?.[0]?.text ?? ''
    expect(text).toContain('me@example.com')
  }, 15000)

  it('reads a real message through get_message', async () => {
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '0' } }, adminToken)
    const call = await rpc('tools/call', { name: 'get_message', arguments: { folder: 'INBOX', uid: 1, mark_seen: false } }, adminToken, { session: sessionId! })
    const text = (call.body as { result?: { content?: { text?: string }[] } }).result?.content?.[0]?.text ?? ''
    const parsed = JSON.parse(text) as { subject: string; bodyText: string }
    expect(parsed.subject).toBe('MCP hello')
    expect(parsed.bodyText).toContain('Hello from MCP test.')
  })

  it('enforces token scopes: read-only token cannot send or delete', async () => {
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '0' } }, readOnlyToken)
    const send = await rpc('tools/call', {
      name: 'send_message',
      arguments: { to: [{ email: 'x@y.co' }], subject: 's', text: 't' },
    }, readOnlyToken, { session: sessionId! })
    // Tool-handler errors surface as isError results carrying the message.
    const sendResult = (send.body as { result?: { isError?: boolean; content?: { text?: string }[] } }).result
    expect(sendResult?.isError).toBe(true)
    expect(sendResult?.content?.map((c) => c.text).join(' ')).toContain('mail:send')

    const del = await rpc('tools/call', { name: 'delete_message', arguments: { folder: 'INBOX', uid: 1 } }, readOnlyToken, { session: sessionId! })
    const delResult = (del.body as { result?: { isError?: boolean; content?: { text?: string }[] } }).result
    expect(delResult?.isError).toBe(true)
    expect(delResult?.content?.map((c) => c.text).join(' ')).toContain('mail:delete')
  })

  it('rejects an invalid token', async () => {
    const res = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '0' } }, 'hmt_invalid')
    expect(res.status).toBe(401)
    const body = res.body as { error?: { message?: string } }
    expect(body.error?.message).toContain('Invalid')
  })

  it('streams POST answers as SSE events (spec-default streamable HTTP)', async () => {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'sse-client', version: '0' } }, adminToken)
    expect(init.status).toBe(200)
    expect(init.contentType).toContain('text/event-stream')
    expect(init.sessionId).toBeTruthy()
    expect((init.body as { result?: unknown }).result).toBeTruthy()
  })

  it('opens a server-initiated SSE stream on GET, heartbeats, and survives client disconnect', async () => {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'sse-get-client', version: '0' } }, adminToken)
    const sid = init.sessionId!
    await rpc('notifications/initialized', undefined, adminToken, { session: sid })

    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'GET',
      headers: { accept: 'text/event-stream', authorization: `Bearer ${adminToken}`, 'mcp-session-id': sid },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    // The stream stays open and delivers keep-alive comment heartbeats.
    const reader = res.body!.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toContain(': keepalive')
    await reader.cancel()

    // Cancelling the GET stream must NOT tear down the session.
    const list = await rpc('tools/list', {}, adminToken, { session: sid })
    expect(list.status).toBe(200)
    expect((list.body as { result?: { tools?: unknown[] } }).result?.tools).toBeTruthy()
  })

  it('rejects GET without a session id', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'GET',
      headers: { accept: 'text/event-stream', authorization: `Bearer ${adminToken}` },
    })
    expect(res.status).toBe(400)
  })
})

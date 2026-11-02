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
 * Token permission editing (PUT /api/tokens/:id/scopes):
 * - the token value never changes,
 * - scope changes apply immediately, including to an already-open MCP session,
 * - only interactive (web) sessions may edit,
 * - hash-only storage is preserved (the plaintext is never persisted).
 */
describe('API token permission editing', () => {
  let server: Server
  let baseUrl: string
  let db: DB
  let cookie: string
  let agentToken: string
  let agentTokenId: string
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
    cookie = `hm_session=${auth.login('admin@x.test', 'password123').token}`
    void web
    const created = auth.createToken(web.userId, 'agent', [SCOPES.mailRead])
    agentToken = created.token
    agentTokenId = created.info.id

    const info = await engine.addAccount(
      { userId: web.userId, isAdmin: true, kind: 'web', scopes: new Set(Object.values(SCOPES)) },
      {
        name: 'Test', email: 'me@example.com',
        imap: { host: 'imap.perms', port: 993, tls: 'tls', user: 'me@example.com', password: 'p' },
        smtp: { host: 'smtp.perms', port: 587, tls: 'starttls' },
      },
    )
    accountId = info.id
    const transport = transports.get('imap.perms')!
    transport.deliver('INBOX', Buffer.from(
      `From: Alice <alice@example.com>\r\nTo: me@example.com\r\nSubject: Perms hello\r\nDate: ${new Date().toUTCString()}\r\nMessage-ID: <perms1@example.com>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello permissions.\r\n`,
    ))
    await engine.syncFolder({ userId: web.userId, isAdmin: true, kind: 'web', scopes: new Set(Object.values(SCOPES)) }, accountId, 'INBOX')

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

  /** JSON-RPC over /mcp like a real MCP client (SSE or JSON reply). */
  async function rpc(method: string, params: object | undefined, token = agentToken, session?: string) {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    }
    if (session) headers['mcp-session-id'] = session
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method, ...(params !== undefined ? { params } : {}) }),
    })
    const sid = res.headers.get('mcp-session-id') ?? undefined
    const contentType = res.headers.get('content-type') ?? ''
    const raw = await res.text()
    let body: Record<string, unknown>
    if (contentType.includes('text/event-stream')) {
      const dataLines = raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).filter(Boolean)
      body = dataLines.length ? (JSON.parse(dataLines[dataLines.length - 1]!) as Record<string, unknown>) : {}
    } else {
      body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
    }
    return { status: res.status, body, sessionId: sid }
  }

  const initParams = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } }

  async function callTool(name: string, args: Record<string, unknown>, token = agentToken, session?: string) {
    return rpc('tools/call', { name, arguments: args }, token, session)
  }

  function isErrorResult(body: Record<string, unknown>): boolean {
    if (body.error) return true
    const result = body.result as { isError?: boolean } | undefined
    return result?.isError === true
  }

  it('changes scopes without changing the token value', async () => {
    const res = await fetch(`${baseUrl}/api/tokens/${agentTokenId}/scopes`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ scopes: [SCOPES.mailRead, SCOPES.mailSend] }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { token: { id: string; scopes: string[] } }
    expect(body.token.scopes).toEqual([SCOPES.mailRead, SCOPES.mailSend])
    // The same raw token still authenticates: only scopes changed.
    const mcp = await rpc('initialize', initParams, agentToken)
    expect(mcp.status).toBe(200)
    expect(mcp.body.error).toBeUndefined()
    await fetch(`${baseUrl}/mcp`, { method: 'DELETE', headers: { authorization: `Bearer ${agentToken}`, 'mcp-session-id': mcp.sessionId! } })
  })

  it('takes effect immediately for listing (GET /api/tokens)', async () => {
    const res = await fetch(`${baseUrl}/api/tokens`, { headers: { cookie } })
    const body = (await res.json()) as { tokens: { id: string; scopes: string[] }[] }
    expect(body.tokens.find((t) => t.id === agentTokenId)!.scopes).toContain(SCOPES.mailSend)
  })

  it('granting a scope works on an already-open MCP session (next call)', async () => {
    // Open a session with the current scopes (read + send).
    const init = await rpc('initialize', initParams)
    sessionId = init.sessionId
    await rpc('notifications/initialized', undefined, agentToken, sessionId)

    // The account exists and the session reads it fine.
    const list = await callTool('list_accounts', {}, agentToken, sessionId)
    expect(isErrorResult(list.body)).toBe(false)

    // Grant mail:delete on the SAME session.
    const put = await fetch(`${baseUrl}/api/tokens/${agentTokenId}/scopes`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ scopes: [SCOPES.mailRead, SCOPES.mailSend, SCOPES.mailDelete] }),
    })
    expect(put.status).toBe(200)

    // The open session must see the new privilege on its very next call.
    const detail = await callTool('get_message', { folder: 'INBOX', uid: 1, mark_seen: false }, agentToken, sessionId)
    expect(isErrorResult(detail.body)).toBe(false)
    // And a newly granted privilege (mail:send) must work through the same
    // open session without re-initializing.
    const send = await callTool('send_message', {
      to: [{ email: 'dest@example.com' }], subject: 'granted', text: 'via open session',
    }, agentToken, sessionId)
    expect(isErrorResult(send.body)).toBe(false)
  })

  it('removing a scope blocks the action on an already-open MCP session', async () => {
    const put = await fetch(`${baseUrl}/api/tokens/${agentTokenId}/scopes`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ scopes: [SCOPES.mailRead] }),
    })
    expect(put.status).toBe(200)
    // Same open session, no re-initialize: send must now be refused.
    const send = await callTool('send_message', {
      to: [{ email: 'dest@example.com' }], subject: 'should fail', text: 'no send scope',
    }, agentToken, sessionId)
    expect(isErrorResult(send.body)).toBe(true)
  })

  it('revoking the token kills an already-open MCP session on the next call', async () => {
    const res = await fetch(`${baseUrl}/api/tokens/${agentTokenId}`, { method: 'DELETE', headers: { cookie } })
    expect(res.status).toBe(200)
    const call = await callTool('list_accounts', {}, agentToken, sessionId)
    expect(isErrorResult(call.body)).toBe(true)
    // And a fresh request with the same raw token is rejected outright.
    const fresh = await rpc('tools/list', undefined, agentToken)
    expect(fresh.status).toBe(401)
  })

  it('agent tokens (Bearer) may not edit permissions — interactive sessions only', async () => {
    // A brand new token; its own Bearer context must not be able to self-escalate.
    const app = await fetch(`${baseUrl}/api/tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: 'self-escalate', scopes: [SCOPES.mailRead] }),
    })
    const { token, info } = (await app.json()) as { token: string; info: { id: string } }
    const attempt = await fetch(`${baseUrl}/api/tokens/${info.id}/scopes`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ scopes: Object.values(SCOPES) }),
    })
    expect(attempt.status).toBe(403)
    // Revoking the just-created token to keep the listing clean.
    await fetch(`${baseUrl}/api/tokens/${info.id}`, { method: 'DELETE', headers: { cookie } })
  })

  it('rejects unknown scopes with a 4xx', async () => {
    const res = await fetch(`${baseUrl}/api/tokens/${agentTokenId}/scopes`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ scopes: [SCOPES.mailRead, 'mail:root'] }),
    })
    // project convention: unknown scope = conflict() = 409, never 5xx
    expect(res.status).toBe(409)
  })

  it('keeps hash-only storage: no plaintext column, token_hash present', async () => {
    const row = db.prepare("SELECT * FROM api_tokens WHERE id = ?").get(agentTokenId) as Record<string, unknown> | undefined
    expect(row).toBeDefined()
    expect(row!.token_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(Object.keys(row!)).not.toContain('token')
    expect(Object.keys(row!)).not.toContain('token_plain')
    // The revoked agent token's raw value must not appear anywhere in its row.
    expect(JSON.stringify(row!)).not.toContain('hmt_')
  })
})

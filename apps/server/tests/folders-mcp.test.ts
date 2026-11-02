import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openInMemoryDatabase, type DB } from '../src/db/database.js'
import { AuthService } from '../src/core/auth-service.js'
import { MailStore } from '../src/core/mail/store.js'
import { MailEngine } from '../src/core/mail/engine.js'
import { AiProviderRegistry } from '../src/core/ai/provider.js'
import { AiService } from '../src/core/ai/service.js'
import { InMemoryTransport, FakeSmtpSender, makeRaw } from './inmemory-transport.js'
import { LocalImapServer } from './local-imap.js'
import { ImapFlowTransport } from '../src/core/mail/imapflow-transport.js'
import { buildApp } from '../src/http/app.js'
import { registerRoutes } from '../src/http/routes.js'
import { registerMcp } from '../src/mcp/server.js'
import type { Config } from '../src/config.js'
import type { AuthContext } from '../src/core/types.js'
import type { Server } from 'node:http'
import { SCOPES } from '../src/core/types.js'
import { AppError } from '../src/core/errors.js'

const masterSecret = Buffer.from('f'.repeat(32))

/** The MCP tools must now expose real IMAP folder management. */
describe('MCP folder tools over HTTP', () => {
  let server: Server
  let baseUrl: string
  let fullToken: string
  let readOnlyToken: string
  let writableNoFolderToken: string

  beforeAll(async () => {
    const db: DB = openInMemoryDatabase()
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
    fullToken = auth.createToken(web.userId, 'full', Object.values(SCOPES)).token
    readOnlyToken = auth.createToken(web.userId, 'ro', [SCOPES.mailRead]).token
    // Can write messages but not manage folders.
    writableNoFolderToken = auth.createToken(web.userId, 'mailwrite', [SCOPES.mailRead, SCOPES.mailWrite]).token

    const info = await engine.addAccount(web, {
      name: 'T', email: 'me@example.com',
      imap: { host: 'imap.folders', port: 993, tls: 'tls', user: 'me@example.com', password: 'p' },
      smtp: { host: 'smtp.folders', port: 587, tls: 'starttls' },
    })
    await engine.syncFolder(web, info.id, 'INBOX')

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
    return { status: res.status, body }
  }

  async function callTool(name: string, args: Record<string, unknown>, token: string) {
    return rpc('tools/call', { name, arguments: args }, token, { session: sessionId! })
  }

  const resultText = (res: { body: Record<string, unknown> }): string => {
    const result = (res.body as { result?: { isError?: boolean; content?: { text?: string }[] } }).result
    return result?.content?.map((c) => c.text).join(' ') ?? ''
  }
  const isError = (res: { body: Record<string, unknown> }): boolean =>
    !!(res.body as { result?: { isError?: boolean } }).result?.isError

  it('exposes create_folder, rename_folder and delete_folder in tools/list', async () => {
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } }, fullToken)
    const list = await rpc('tools/list', {}, fullToken, { session: sessionId! })
    const tools = ((list.body as { result?: { tools?: { name: string }[] } }).result?.tools ?? []).map((t) => t.name)
    expect(tools).toEqual(expect.arrayContaining(['create_folder', 'rename_folder', 'delete_folder']))
    expect(tools).toHaveLength(17)
  })

  it('runs the create → rename → delete cycle through MCP', async () => {
    const created = await callTool('create_folder', { path: 'McpTemp' }, fullToken)
    expect(isError(created)).toBe(false)
    expect(resultText(created)).toContain('McpTemp')

    const renamed = await callTool('rename_folder', { path: 'McpTemp', new_path: 'McpTemp2' }, fullToken)
    expect(isError(renamed)).toBe(false)
    expect(resultText(renamed)).toContain('McpTemp2')
    expect(resultText(renamed)).not.toContain('"McpTemp"')

    const deleted = await callTool('delete_folder', { path: 'McpTemp2' }, fullToken)
    expect(isError(deleted)).toBe(false)
    expect(resultText(deleted)).not.toContain('McpTemp2')
  })

  it('refuses folder tools without the folder scopes (immediate effect)', async () => {
    // Fresh session, read-only token.
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } }, readOnlyToken)
    const roSession = sessionId!

    const create = await callTool('create_folder', { path: 'Nope' }, readOnlyToken)
    expect(isError(create)).toBe(true)
    expect(resultText(create)).toContain('folder:write')

    const del = await callTool('delete_folder', { path: 'Whatever' }, readOnlyToken)
    expect(isError(del)).toBe(true)
    expect(resultText(del)).toContain('folder:delete')

    // mail:write alone is NOT enough for folder management.
    sessionId = undefined
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } }, writableNoFolderToken)
    const writeOnly = await callTool('create_folder', { path: 'Nope' }, writableNoFolderToken)
    expect(isError(writeOnly)).toBe(true)
    expect(resultText(writeOnly)).toContain('folder:write')
    void roSession
  })

  it('refuses to delete INBOX or a system folder through MCP', async () => {
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } }, fullToken)
    const inbox = await callTool('delete_folder', { path: 'INBOX', confirm: true }, fullToken)
    expect(isError(inbox)).toBe(true)
    expect(resultText(inbox)).toContain('INBOX')

    const trash = await callTool('delete_folder', { path: 'Trash' }, fullToken)
    expect(isError(trash)).toBe(true)
    expect(resultText(trash)).toContain('system folder')

    const renameInbox = await callTool('rename_folder', { path: 'INBOX', new_path: 'X' }, fullToken)
    expect(isError(renameInbox)).toBe(true)
    expect(resultText(renameInbox)).toContain('INBOX')
  })
})

/**
 * The engine talks to a REAL IMAP server (LocalImapServer over TCP): the
 * create → rename → delete cycle must be verifiable on the server itself.
 */
describe('Folder management against a real IMAP server (engine level)', () => {
  let db: DB
  let engine: MailEngine
  let auth: AuthService
  let imap: LocalImapServer
  let ctx: AuthContext
  let limitedWrite: AuthContext
  let limitedDelete: AuthContext
  let accountId: string

  beforeAll(async () => {
    imap = new LocalImapServer()
    await imap.start()
    db = openInMemoryDatabase()
    auth = new AuthService(db, 24)
    const store = new MailStore(db)
    engine = new MailEngine(
      db,
      { port: 0, host: '', dataDir: '', masterSecret, webDist: undefined, trustProxy: false, sessionTtlHours: 1, initialSyncLimit: 20, bodyIndexLimit: 20, maxAttachmentSize: 100_000 } satisfies Config,
      store,
      async (cfg) => ImapFlowTransport.connect({ host: '127.0.0.1', port: imap.port, tls: 'none', user: cfg.user, password: 'p' }),
      new FakeSmtpSender().sender,
      () => {},
    )
    auth.createUserGuarded({ email: 'u@x.test', password: 'password123' })
    const web = auth.contextForSession(auth.login('u@x.test', 'password123').token)!
    ctx = { userId: web.userId, isAdmin: web.isAdmin, kind: 'web', scopes: new Set(Object.values(SCOPES)) }
    limitedWrite = { ...ctx, scopes: new Set([SCOPES.mailRead, SCOPES.mailWrite]) }
    limitedDelete = { ...ctx, scopes: new Set([SCOPES.mailRead, SCOPES.folderWrite]) }

    const info = await engine.addAccount(ctx, {
      name: 'T', email: 'me@example.com',
      imap: { host: '127.0.0.1', port: imap.port, tls: 'none', user: 'u@x.test', password: 'p' },
      smtp: { host: '127.0.0.1', port: 9587, tls: 'none' },
    })
    accountId = info.id
  })

  afterAll(async () => {
    await engine.close()
    await imap.stop()
  })

  it('creates a folder visible on the IMAP server and in the cache', async () => {
    await engine.createFolder(ctx, accountId, 'Temp')
    expect(imap.folders.has('Temp')).toBe(true)
    const paths = (await engine.listFolders(ctx, accountId)).map((f) => f.path)
    expect(paths).toContain('Temp')
  })

  it('renames it on the IMAP server (old name gone, new name present)', async () => {
    await engine.renameFolder(ctx, accountId, 'Temp', 'Temp2')
    expect(imap.folders.has('Temp')).toBe(false)
    expect(imap.folders.has('Temp2')).toBe(true)
  })

  it('deletes it on the IMAP server (cycle complete)', async () => {
    await engine.deleteFolder(ctx, accountId, 'Temp2')
    expect(imap.folders.has('Temp2')).toBe(false)
    const paths = (await engine.listFolders(ctx, accountId)).map((f) => f.path)
    expect(paths).not.toContain('Temp2')
  })

  it('refuses creating a folder named INBOX', async () => {
    await expect(engine.createFolder(ctx, accountId, 'INBOX')).rejects.toThrowError(AppError)
    await expect(engine.createFolder(ctx, accountId, 'inbox')).rejects.toThrowError(AppError)
  })

  it('protects INBOX and system folders from rename/delete', async () => {
    await expect(engine.renameFolder(ctx, accountId, 'INBOX', 'Renamed')).rejects.toThrowError(/INBOX/)
    await expect(engine.deleteFolder(ctx, accountId, 'INBOX', { confirm: true })).rejects.toThrowError(/INBOX/)
    await expect(engine.deleteFolder(ctx, accountId, 'Trash', { confirm: true })).rejects.toThrowError(/system folder/)
    await expect(engine.renameFolder(ctx, accountId, 'Sent', 'Old Sent')).rejects.toThrowError(/system folder/)
    // The protected folders are still there.
    expect(imap.folders.has('INBOX')).toBe(true)
    expect(imap.folders.has('Trash')).toBe(true)
    expect(imap.folders.has('Sent')).toBe(true)
  })

  it('requires confirm=true before deleting a non-empty folder, then deletes it', async () => {
    imap.deliver('Work', makeRaw({ subject: 'keep me' }))
    await engine.syncFolder(ctx, accountId, 'Work')
    await expect(engine.deleteFolder(ctx, accountId, 'Work')).rejects.toThrowError(/confirm/)
    expect(imap.folders.has('Work')).toBe(true)
    await engine.deleteFolder(ctx, accountId, 'Work', { confirm: true })
    expect(imap.folders.has('Work')).toBe(false)
  })

  it('enforces the new scopes at engine level', async () => {
    await expect(engine.createFolder(limitedWrite, accountId, 'Denied')).rejects.toThrowError(/folder:write/)
    await expect(engine.renameFolder(limitedWrite, accountId, 'Whatever', 'X')).rejects.toThrowError(/folder:write/)
    // folder:write alone does not grant deletion.
    await expect(engine.deleteFolder(limitedDelete, accountId, 'SomeFolder')).rejects.toThrowError(/folder:delete/)
    // Nothing was created on the server.
    expect(imap.folders.has('Denied')).toBe(false)
  })
})

/**
 * Pooled connections die silently (IMAP idle timeouts, NAT drops). The pool's
 * NOOP pre-flight must detect it and reconnect — for reads AND for mutations,
 * which are never blindly retried.
 */
describe('Pool pre-flight: dead pooled connection is replaced, not used', () => {
  it('drops the dead transport and reconnects on the next operation', async () => {
    const db = openInMemoryDatabase()
    const auth = new AuthService(db, 24)
    const store = new MailStore(db)
    const transports: InMemoryTransport[] = []
    const engine = new MailEngine(
      db,
      { port: 0, host: '', dataDir: '', masterSecret, webDist: undefined, trustProxy: false, sessionTtlHours: 1, initialSyncLimit: 20, bodyIndexLimit: 20, maxAttachmentSize: 100_000 } satisfies Config,
      store,
      async (cfg) => {
        const t = new InMemoryTransport(cfg.user)
        transports.push(t)
        return t
      },
      new FakeSmtpSender().sender,
      () => {},
    )
    auth.createUserGuarded({ email: 'u@x.test', password: 'password123' })
    const web = auth.contextForSession(auth.login('u@x.test', 'password123').token)!
    const ctx = { userId: web.userId, isAdmin: web.isAdmin, kind: 'web' as const, scopes: new Set(Object.values(SCOPES)) }
    const info = await engine.addAccount(ctx, {
      name: 'T', email: 'me@example.com',
      imap: { host: 'imap.pool', port: 993, tls: 'tls', user: 'me@example.com', password: 'p' },
      smtp: { host: 'smtp.pool', port: 587, tls: 'starttls' },
    })
    await engine.createFolder(ctx, info.id, 'Before')
    const before = transports.length

    // The pooled connection dies (server-side idle close): every existing
    // transport stops answering NOOP.
    for (const t of transports) t.noopFails = true

    // A MUTATING operation must still succeed on a fresh connection.
    await engine.createFolder(ctx, info.id, 'After')
    expect(transports).toHaveLength(before + 1)
    for (const t of transports.slice(0, before)) expect(t.closed).toBe(true) // dead ones closed, not leaked
    expect(transports[before]!.folders.has('After')).toBe(true)
  })
})

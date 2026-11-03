import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { AppError, badRequest, forbidden } from '../core/errors.js'
import type { AuthService } from '../core/auth-service.js'
import type { MailEngine } from '../core/mail/engine.js'
import type { AiProviderRegistry } from '../core/ai/provider.js'
import type { AiService } from '../core/ai/service.js'
import { SESSION_COOKIE, requireAuth } from './app.js'
import { sanitizeFilename } from '../core/mail/sanitize.js'
import type { MailAccountInput } from '../core/types.js'
import { isUiLocale, UI_LOCALES } from '../core/types.js'

export interface RouteDeps {
  auth: AuthService
  engine: MailEngine
  aiRegistry: AiProviderRegistry
  aiService: AiService
  secureCookies: boolean
}

// ----- simple in-memory login rate limiter -------------------------------------------

const attempts = new Map<string, { count: number; resetAt: number }>()
const WINDOW_MS = 15 * 60 * 1000
const MAX_ATTEMPTS = 10

function checkLoginRate(key: string): void {
  const entry = attempts.get(key)
  if (!entry) return
  if (entry.resetAt < Date.now()) {
    attempts.delete(key)
    return
  }
  if (entry.count >= MAX_ATTEMPTS) {
    throw new AppError('forbidden', 'Too many failed login attempts. Try again later.')
  }
}

function recordLoginFailure(key: string): void {
  // Opportunistic sweep so the map cannot grow without bound.
  const now = Date.now()
  for (const [k, v] of attempts) {
    if (v.resetAt < now) attempts.delete(k)
  }
  const entry = attempts.get(key)
  if (!entry || entry.resetAt < now) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS })
    return
  }
  entry.count += 1
}

// ----- schemas -------------------------------------------------------------------------

const AddressSchema = z.object({ name: z.string().optional(), email: z.string() })
const addressList = z.array(AddressSchema)

const accountInputSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  imap: z.object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    tls: z.enum(['tls', 'starttls', 'none']).default('tls'),
    user: z.string().min(1),
    password: z.string().min(1),
  }),
  smtp: z.object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    tls: z.enum(['tls', 'starttls', 'none']).default('tls'),
    user: z.string().optional(),
    password: z.string().optional(),
  }),
})

const sendSchema = z.object({
  accountId: z.string().min(1),
  to: addressList.default([]),
  cc: addressList.optional(),
  bcc: addressList.optional(),
  subject: z.string().default(''),
  text: z.string().optional(),
  html: z.string().optional(),
  inReplyTo: z.string().optional(),
  references: z.array(z.string()).optional(),
  attachments: z
    .array(
      z.object({
        filename: z.string().min(1),
        contentType: z.string().min(1),
        contentBase64: z.string().min(1),
      }),
    )
    .optional(),
})

// ----- route registration ---------------------------------------------------------------

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { auth, engine, aiRegistry, aiService } = deps

  // ---- auth -------------------------------------------------------------------------

  app.get('/api/health', async () => ({ ok: true, name: 'hermodmail', version: '0.1.0-beta.1' }))

  app.get('/api/setup/status', async () => ({ needsSetup: auth.userCount() === 0 }))

  app.post('/api/setup', async (req, reply) => {
    if (auth.userCount() !== 0) throw forbidden('Setup already completed')
    const body = z
      .object({ email: z.string().email(), password: z.string().min(8), displayName: z.string().optional() })
      .parse(req.body)
    const user = auth.createUserGuarded(body)
    const { token } = auth.login(body.email, body.password)
    setSessionCookie(reply, token, deps.secureCookies)
    return { user }
  })

  app.post('/api/auth/login', async (req, reply) => {
    const body = z.object({ email: z.string(), password: z.string() }).parse(req.body)
    const key = `${req.ip}|${body.email.toLowerCase()}`
    checkLoginRate(key)
    try {
      const { user, token } = auth.login(body.email, body.password)
      setSessionCookie(reply, token, deps.secureCookies)
      return { user }
    } catch (err) {
      if (err instanceof AppError && err.status === 401) recordLoginFailure(key)
      throw err
    }
  })

  app.post('/api/auth/logout', async (req, reply) => {
    auth.logout(req.cookies[SESSION_COOKIE])
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return { ok: true }
  })

  app.get('/api/auth/me', async (req) => {
    const ctx = requireAuth(req)
    return { user: auth.getUser(ctx.userId) }
  })

  // ---- users (admin) --------------------------------------------------------------------

  app.get('/api/users', async (req) => {
    const ctx = requireAuth(req)
    return { users: auth.listUsers(ctx) }
  })

  app.post('/api/users', async (req) => {
    const ctx = requireAuth(req)
    const body = z
      .object({ email: z.string().email(), password: z.string().min(8), displayName: z.string().optional(), isAdmin: z.boolean().optional() })
      .parse(req.body)
    // createUserGuarded requires admin when a user already exists.
    return { user: auth.createUserGuarded({ ...body, isAdmin: body.isAdmin ?? false }, ctx) }
  })

  app.patch('/api/users/:id/password', async (req) => {
    const ctx = requireAuth(req)
    const { id } = z.object({ id: z.string() }).parse(req.params)
    const body = z.object({ password: z.string().min(8) }).parse(req.body)
    auth.updatePassword(id, body.password, ctx)
    return { ok: true }
  })

  app.delete('/api/users/:id', async (req) => {
    const ctx = requireAuth(req)
    const { id } = z.object({ id: z.string() }).parse(req.params)
    auth.deleteUser(id, ctx)
    return { ok: true }
  })

  // ---- API tokens (agents) ------------------------------------------------------------------

  app.get('/api/tokens', async (req) => {
    const ctx = requireAuth(req)
    return { tokens: auth.listTokens(ctx.userId) }
  })

  app.post('/api/tokens', async (req) => {
    const ctx = requireAuth(req)
    const body = z.object({ name: z.string().min(1), scopes: z.array(z.string()) }).parse(req.body)
    return auth.createToken(ctx.userId, body.name, body.scopes)
  })

  app.delete('/api/tokens/:id', async (req) => {
    const ctx = requireAuth(req)
    const { id } = z.object({ id: z.string() }).parse(req.params)
    auth.revokeToken(ctx.userId, id)
    return { ok: true }
  })

  app.put('/api/tokens/:id/scopes', async (req) => {
    const ctx = requireAuth(req)
    // Editing token permissions is a web-UI operation: an agent token must
    // never be able to grant itself new scopes. The server re-reads the row
    // on every request, so the change applies immediately — including to
    // already-open MCP sessions.
    if (ctx.kind !== 'web') throw forbidden('Token permissions can only be edited from an interactive session')
    const { id } = z.object({ id: z.string() }).parse(req.params)
    const body = z.object({ scopes: z.array(z.string()) }).parse(req.body)
    return { token: auth.updateTokenScopes(ctx.userId, id, body.scopes) }
  })

  // ---- mail accounts -----------------------------------------------------------------------

  app.get('/api/accounts', async (req) => ({ accounts: engine.listAccounts(requireAuth(req)) }))

  app.post('/api/accounts', async (req) => {
    const ctx = requireAuth(req)
    const input = accountInputSchema.parse(req.body) as MailAccountInput
    return { account: await engine.addAccount(ctx, input) }
  })

  const accountUpdateSchema = z.object({
    name: z.string().min(1).optional(),
    email: z.string().email().optional(),
    imap: z
      .object({
        host: z.string().min(1).optional(),
        port: z.number().int().min(1).max(65535).optional(),
        tls: z.enum(['tls', 'starttls', 'none']).optional(),
        user: z.string().optional(),
        password: z.string().optional(),
      })
      .optional(),
    smtp: z
      .object({
        host: z.string().min(1).optional(),
        port: z.number().int().min(1).max(65535).optional(),
        tls: z.enum(['tls', 'starttls', 'none']).optional(),
        user: z.string().optional(),
        password: z.string().optional(),
      })
      .optional(),
  })

  app.patch('/api/accounts/:id', async (req) => {
    const ctx = requireAuth(req)
    const { id } = z.object({ id: z.string() }).parse(req.params)
    const body = accountUpdateSchema.parse(req.body)
    return { account: await engine.updateAccount(ctx, id, body) }
  })

  app.delete('/api/accounts/:id', async (req) => {
    const ctx = requireAuth(req)
    const { id } = z.object({ id: z.string() }).parse(req.params)
    engine.deleteAccount(ctx, id)
    return { ok: true }
  })

  app.post('/api/accounts/:id/test', async (req) => {
    const ctx = requireAuth(req)
    const { id } = z.object({ id: z.string() }).parse(req.params)
    return engine.testAccount(ctx, id)
  })

  // ---- folders ----------------------------------------------------------------------------------

  app.get('/api/accounts/:id/folders', async (req) => {
    const ctx = requireAuth(req)
    const { id } = z.object({ id: z.string() }).parse(req.params)
    const query = z.object({ refresh: z.coerce.boolean().default(false) }).parse(req.query)
    return { folders: await engine.listFolders(ctx, id, { refresh: query.refresh }) }
  })

  app.post('/api/accounts/:id/folders', async (req) => {
    const ctx = requireAuth(req)
    const { id } = z.object({ id: z.string() }).parse(req.params)
    const body = z.object({ path: z.string().min(1) }).parse(req.body)
    return { folders: await engine.createFolder(ctx, id, body.path) }
  })

  app.patch('/api/accounts/:id/folders', async (req) => {
    const ctx = requireAuth(req)
    const { id } = z.object({ id: z.string() }).parse(req.params)
    const body = z.object({ path: z.string().min(1), newPath: z.string().min(1) }).parse(req.body)
    return { folders: await engine.renameFolder(ctx, id, body.path, body.newPath) }
  })

  app.delete('/api/accounts/:id/folders', async (req) => {
    const ctx = requireAuth(req)
    const { id } = z.object({ id: z.string() }).parse(req.params)
    const query = z.object({ path: z.string().min(1), confirm: z.coerce.boolean().optional() }).parse(req.query)
    return { folders: await engine.deleteFolder(ctx, id, query.path, { confirm: query.confirm }) }
  })

  app.post('/api/accounts/:id/sync', async (req) => {
    const ctx = requireAuth(req)
    const { id } = z.object({ id: z.string() }).parse(req.params)
    const body = z.object({ folder: z.string() }).parse(req.body)
    return engine.syncFolder(ctx, id, body.folder)
  })

  // ---- user settings -------------------------------------------------------------------

  app.get('/api/settings', async (req) => {
    const ctx = requireAuth(req)
    return { refreshIntervalMs: engine.getRefreshIntervalMs(ctx), locale: engine.getUserLocale(ctx) }
  })

  app.put('/api/settings', async (req) => {
    const ctx = requireAuth(req)
    const body = z
      .object({ refreshIntervalMs: z.number().int().min(0).optional(), locale: z.string().optional() })
      .refine((b) => b.refreshIntervalMs !== undefined || b.locale !== undefined, 'Nothing to update')
      .parse(req.body)
    if (body.locale !== undefined) engine.setUserLocale(ctx, body.locale)
    const refreshIntervalMs = body.refreshIntervalMs !== undefined ? engine.setRefreshIntervalMs(ctx, body.refreshIntervalMs) : engine.getRefreshIntervalMs(ctx)
    return { refreshIntervalMs, locale: engine.getUserLocale(ctx) }
  })

  // ---- messages -----------------------------------------------------------------------------------

  app.get('/api/accounts/:id/messages', async (req) => {
    const ctx = requireAuth(req)
    const { id } = z.object({ id: z.string() }).parse(req.params)
    const query = z
      .object({
        folder: z.string().min(1),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        filter: z.enum(['all', 'unseen', 'flagged', 'attachments']).default('all'),
        q: z.string().optional(),
        sync: z.coerce.boolean().default(true),
      })
      .parse(req.query)
    return engine.listMessages(ctx, id, query)
  })

  app.get('/api/accounts/:id/messages/:folder/:uid', async (req) => {
    const ctx = requireAuth(req)
    const { id } = z.object({ id: z.string() }).parse(req.params)
    const params = z.object({ folder: z.string(), uid: z.coerce.number().int().min(1) }).parse(req.params)
    const query = z.object({ markSeen: z.coerce.boolean().default(true) }).parse(req.query)
    return engine.getMessage(ctx, id, params.folder, params.uid, { markSeen: query.markSeen })
  })

  app.patch('/api/accounts/:id/messages/:folder/:uid', async (req) => {
    const ctx = requireAuth(req)
    const { id } = z.object({ id: z.string() }).parse(req.params)
    const params = z.object({ folder: z.string(), uid: z.coerce.number().int().min(1) }).parse(req.params)
    const body = z.object({ seen: z.boolean().optional(), flagged: z.boolean().optional() }).parse(req.body ?? {})
    return engine.patchMessage(ctx, id, params.folder, params.uid, body)
  })

  app.post('/api/accounts/:id/messages/:folder/:uid/move', async (req) => {
    const ctx = requireAuth(req)
    const { id } = z.object({ id: z.string() }).parse(req.params)
    const params = z.object({ folder: z.string(), uid: z.coerce.number().int().min(1) }).parse(req.params)
    const body = z.object({ to: z.string().min(1) }).parse(req.body)
    await engine.moveMessage(ctx, id, params.folder, params.uid, body.to)
    return { ok: true }
  })

  app.delete('/api/accounts/:id/messages/:folder/:uid', async (req) => {
    const ctx = requireAuth(req)
    const { id } = z.object({ id: z.string() }).parse(req.params)
    const params = z.object({ folder: z.string(), uid: z.coerce.number().int().min(1) }).parse(req.params)
    await engine.deleteMessage(ctx, id, params.folder, params.uid)
    return { ok: true }
  })

  app.get('/api/accounts/:id/messages/:folder/:uid/markdown', async (req, reply) => {
    const ctx = requireAuth(req)
    const { id } = z.object({ id: z.string() }).parse(req.params)
    const params = z.object({ folder: z.string(), uid: z.coerce.number().int().min(1) }).parse(req.params)
    const md = await engine.exportMarkdown(ctx, id, params.folder, params.uid)
    reply.header('content-type', 'text/markdown; charset=utf-8')
    return md
  })

  app.get('/api/attachments/:accountId/:attachmentId', async (req, reply) => {
    const ctx = requireAuth(req)
    const params = z.object({ accountId: z.string(), attachmentId: z.string() }).parse(req.params)
    const att = engine.getAttachment(ctx, params.accountId, params.attachmentId)
    // The filename comes from attacker-controlled email headers.
    const safeName = sanitizeFilename(att.filename)
    reply.header('content-type', 'application/octet-stream')
    reply.header('content-disposition', `attachment; filename="${safeName}"`)
    reply.header('x-content-type-options', 'nosniff')
    return att.content
  })

  // ---- send & search --------------------------------------------------------------------------------

  app.post('/api/send', async (req) => {
    const ctx = requireAuth(req)
    const body = sendSchema.parse(req.body)
    return engine.sendMessage(ctx, body)
  })

  // ---- drafts ---------------------------------------------------------------------------------------

  const draftSchema = z.object({
    accountId: z.string().min(1),
    to: addressList.default([]),
    cc: addressList.optional(),
    bcc: addressList.optional(),
    subject: z.string().default(''),
    text: z.string().optional(),
    html: z.string().optional(),
    inReplyTo: z.string().optional(),
    references: z.array(z.string()).optional(),
  })

  // Saving a draft is a mailbox write (\Draft APPEND), never a send.
  app.post('/api/drafts', async (req) => {
    const ctx = requireAuth(req)
    const body = draftSchema.parse(req.body)
    return engine.saveDraft(ctx, body)
  })

  // ---- contacts --------------------------------------------------------------------------------------

  app.get('/api/contacts', async (req) => {
    const ctx = requireAuth(req)
    const query = z
      .object({ q: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(100) })
      .parse(req.query)
    return { contacts: engine.listContacts(ctx, query) }
  })

  app.get('/api/contacts/suggest', async (req) => {
    const ctx = requireAuth(req)
    const query = z
      .object({ q: z.string().default(''), limit: z.coerce.number().int().min(1).max(50).default(8) })
      .parse(req.query)
    return { contacts: engine.suggestContacts(ctx, query.q, query.limit) }
  })

  app.post('/api/contacts', async (req) => {
    const ctx = requireAuth(req)
    const body = z.object({ email: z.string().min(3), name: z.string().optional() }).parse(req.body)
    return { contact: engine.createContact(ctx, body) }
  })

  app.patch('/api/contacts/:id', async (req) => {
    const ctx = requireAuth(req)
    const { id } = z.object({ id: z.string() }).parse(req.params)
    const body = z.object({ name: z.string().optional(), email: z.string().optional() }).parse(req.body)
    return { contact: engine.updateContact(ctx, id, body) }
  })

  app.delete('/api/contacts/:id', async (req) => {
    const ctx = requireAuth(req)
    const { id } = z.object({ id: z.string() }).parse(req.params)
    engine.deleteContact(ctx, id)
    return { ok: true }
  })

  app.get('/api/search', async (req) => {
    const ctx = requireAuth(req)
    const query = z
      .object({ q: z.string().min(1), accountId: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) })
      .parse(req.query)
    return { results: engine.searchMessages(ctx, { accountId: query.accountId, query: query.q, limit: query.limit }) }
  })

  // ---- AI ---------------------------------------------------------------------------------------------

  app.get('/api/ai/settings', async (req) => {
    const ctx = requireAuth(req)
    auth.requireAdmin(ctx)
    const s = aiRegistry.getSettings()
    return { settings: s }
  })

  app.put('/api/ai/settings', async (req) => {
    const ctx = requireAuth(req)
    auth.requireAdmin(ctx)
    const body = z
      .object({
        provider: z.enum(['none', 'ollama', 'openai']),
        baseUrl: z.string().optional(),
        model: z.string().optional(),
        apiKey: z.string().optional(),
        systemHint: z.string().max(500).optional(),
      })
      .parse(req.body)
    return { settings: aiRegistry.setSettings(body) }
  })

  app.post('/api/ai/test', async (req) => {
    const ctx = requireAuth(req)
    auth.requireAdmin(ctx)
    return aiRegistry.testProvider()
  })

  app.post('/api/ai/summarize', async (req) => {
    const ctx = requireAuth(req)
    const body = aiMessageRefSchema.parse(req.body)
    return aiService.summarize(ctx, body.accountId, body.folder, body.uid)
  })

  app.post('/api/ai/classify', async (req) => {
    const ctx = requireAuth(req)
    const body = aiMessageRefSchema.parse(req.body)
    return aiService.classify(ctx, body.accountId, body.folder, body.uid)
  })

  app.post('/api/ai/draft', async (req) => {
    const ctx = requireAuth(req)
    const body = aiMessageRefSchema.extend({ instructions: z.string().max(2000).optional() }).parse(req.body)
    return aiService.draftReply(ctx, body.accountId, body.folder, body.uid, body.instructions)
  })

  app.post('/api/ai/translate', async (req) => {
    const ctx = requireAuth(req)
    const body = aiMessageRefSchema.extend({ target: z.string().min(2).max(5) }).parse(req.body)
    if (!isUiLocale(body.target)) throw badRequest(`Unsupported target language (supported: ${UI_LOCALES.join(', ')})`)
    return { translation: await aiService.translate(ctx, body.accountId, body.folder, body.uid, body.target) }
  })
}

const aiMessageRefSchema = z.object({ accountId: z.string().min(1), folder: z.string().min(1), uid: z.number().int().min(1) })

function setSessionCookie(reply: { cookie: (name: string, value: string, opts: Record<string, unknown>) => void }, token: string, secure: boolean): void {
  reply.cookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure,
    maxAge: 14 * 24 * 3600 * 1000,
  })
}

import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { AuthContext } from '../core/types.js'
import { AppError } from '../core/errors.js'
import { sha256Hex } from '../core/crypto.js'
import type { AuthService } from '../core/auth-service.js'
import type { MailEngine } from '../core/mail/engine.js'
import type { AiService } from '../core/ai/service.js'

export interface McpDeps {
  auth: AuthService
  engine: MailEngine
  aiService: AiService
  /** SSE keep-alive interval for streamable-HTTP streams (ms); defaults to 15 s. */
  keepAliveMs?: number
}

interface Session {
  transport: StreamableHTTPServerTransport
  server: McpServer
  userId: string
  /** sha256 of the bearer token, so tool calls re-resolve scopes per call. */
  tokenHash: string
}

/**
 * Native MCP server exposing the same HermodMail engine as the web UI.
 *
 * - Transport: streamable HTTP at POST/GET/DELETE /mcp. POST answers stream
 *   back over SSE (spec default); GET opens a session's server-initiated SSE
 *   stream, kept alive with comment heartbeats so proxies do not drop it.
 * - Auth: `Authorization: Bearer hmt_…` (an agent API token)
 * - Permissions: every tool call goes through the engine, which enforces the
 *   token's scopes (mail:read / mail:write / mail:send / mail:delete / folder:write / folder:delete / ai:use).
 *   Scopes are re-resolved from the database on every call, so editing a
 *   token's permissions — or revoking it — takes effect inside an already
 *   open session immediately.
 */
export function registerMcp(app: FastifyInstance, deps: McpDeps): void {
  const sessions = new Map<string, Session>()

  const authenticate = (req: FastifyRequest): AuthContext => {
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) {
      throw new McpError(ErrorCode.InvalidRequest, 'Missing Authorization: Bearer <token> header')
    }
    const ctx = deps.auth.contextForToken(header.slice(7).trim())
    if (!ctx) {
      throw new McpError(ErrorCode.InvalidRequest, 'Invalid or revoked API token')
    }
    return ctx
  }

  const bearerTokenHash = (req: FastifyRequest): string => sha256Hex((req.headers.authorization ?? '').slice(7).trim())

  app.post('/mcp', async (req, reply) => {
    let ctx: AuthContext
    try {
      ctx = authenticate(req)
    } catch (err) {
      reply.status(401).send({ jsonrpc: '2.0', error: { code: -32000, message: (err as Error).message }, id: null })
      return
    }
    const tokenHash = bearerTokenHash(req)
    const sessionId = req.headers['mcp-session-id'] as string | undefined
    const existing = sessionId ? sessions.get(sessionId) : undefined
    if (sessionId && !existing) {
      reply.status(404).send({ jsonrpc: '2.0', error: { code: -32001, message: 'MCP session not found; re-initialize' }, id: null })
      return
    }
    if (existing) {
      if (existing.userId !== ctx.userId) {
        reply.status(401).send({ jsonrpc: '2.0', error: { code: -32000, message: 'Token does not match session owner' }, id: null })
        return
      }
      reply.hijack()
      await existing.transport.handleRequest(req.raw, reply.raw, req.body as unknown)
      return
    }
    // New session: the transport generates its id while handling `initialize`,
    // so we hijack the reply first and register the session afterwards.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      keepAliveMs: deps.keepAliveMs ?? 15_000,
    })
    const server = buildMcpServer(freshContext(tokenHash), deps)
    await server.connect(transport)
    reply.hijack()
    await transport.handleRequest(req.raw, reply.raw, req.body as unknown)
    const newId = transport.sessionId
    if (newId) {
      sessions.set(newId, { transport, server, userId: ctx.userId, tokenHash })
      transport.onclose = () => sessions.delete(newId)
    }
  })

  /**
   * Re-resolve the token's AuthContext from the database on every tool call:
   * an open MCP session must never keep privileges the token no longer has
   * (scope change or revocation apply to the very next call).
   */
  const freshContext = (hash: string) => (): AuthContext => {
    const fresh = deps.auth.contextForTokenHash(hash)
    if (!fresh) throw new McpError(ErrorCode.InvalidRequest, 'Invalid or revoked API token')
    return fresh
  }

  app.get('/mcp', async (req, reply) => {
    let ctx: AuthContext
    try {
      ctx = authenticate(req)
    } catch (err) {
      reply.status(401).send({ jsonrpc: '2.0', error: { code: -32000, message: (err as Error).message }, id: null })
      return
    }
    const sessionId = req.headers['mcp-session-id'] as string | undefined
    const existing = sessionId ? sessions.get(sessionId) : undefined
    if (!existing) {
      reply.status(400).send({ jsonrpc: '2.0', error: { code: -32000, message: 'Mcp-Session-Id from initialize is required for server-initiated streams' }, id: null })
      return
    }
    if (existing.userId !== ctx.userId) {
      reply.status(401).send({ jsonrpc: '2.0', error: { code: -32000, message: 'Token does not match session owner' }, id: null })
      return
    }
    // Open the session's server-initiated SSE stream (heartbeats only until the
    // server actually has something to push). A client disconnect here does not
    // tear down the session — POST keeps working, the client may reconnect.
    reply.hijack()
    await existing.transport.handleRequest(req.raw, reply.raw, undefined)
  })

  app.delete('/mcp', async (req, reply) => {
    try {
      authenticate(req)
    } catch (err) {
      reply.status(401).send({ jsonrpc: '2.0', error: { code: -32000, message: (err as Error).message }, id: null })
      return
    }
    const sessionId = req.headers['mcp-session-id'] as string | undefined
    const session = sessionId ? sessions.get(sessionId) : undefined
    if (session) {
      reply.hijack()
      await session.transport.handleRequest(req.raw, reply.raw, undefined)
      sessions.delete(sessionId!)
    } else {
      reply.status(404).send({ jsonrpc: '2.0', error: { code: -32001, message: 'MCP session not found' }, id: null })
    }
  })

  app.addHook('onClose', async () => {
    for (const [, s] of sessions) await s.transport.close().catch(() => {})
    sessions.clear()
  })
}

function toolError(err: unknown): never {
  if (err instanceof AppError) {
    const code =
      err.code === 'bad_request' ? ErrorCode.InvalidParams
      : err.code === 'unauthorized' || err.code === 'forbidden' ? ErrorCode.InvalidRequest
      : err.code === 'not_found' ? ErrorCode.InvalidRequest
      : ErrorCode.InternalError
    throw new McpError(code, `${err.code}: ${err.message}`)
  }
  throw err
}

function json(obj: unknown): string {
  return JSON.stringify(obj, null, 2)
}

function buildMcpServer(getCtx: () => AuthContext, deps: McpDeps): McpServer {
  const { engine, aiService } = deps
  const server = new McpServer(
    { name: 'hermodmail', version: '0.1.0-beta.1' },
    {
      instructions:
        'HermodMail MCP server: access mailboxes shared with you. All operations are permission-scoped by the token; send, folder management and message deletion require explicit grants (mail:send, folder:write, folder:delete, mail:delete). create_draft saves a real IMAP draft without sending anything; sending mail requires the mail:send scope via send_message. Folder tools operate on the real IMAP server: create_folder, rename_folder (folder:write) and delete_folder (folder:delete, confirm=true needed for non-empty folders).',
    },
  )

  const addressSchema = z.object({ name: z.string().optional(), email: z.string().describe('email address') })

  server.tool('list_accounts', 'List the mail accounts available to the authenticated user.', {}, async () => {
    try {
      const ctx = getCtx()
      return { content: [{ type: 'text' as const, text: json(engine.listAccounts(ctx)) }] }
    } catch (err) {
      toolError(err)
    }
  })

  server.tool(
    'list_folders',
    'List mailbox folders with unread counts.',
    { account_id: z.string().optional().describe('Account id (omit for the first account)'), refresh: z.boolean().optional().describe('Refresh the folder list from the server first') },
    async ({ account_id, refresh }) => {
      try {
        const ctx = getCtx()
        const accountId = account_id ?? (await defaultAccountId(ctx, engine))
        return { content: [{ type: 'text' as const, text: json(await engine.listFolders(ctx, accountId, { refresh })) }] }
      } catch (err) {
        toolError(err)
      }
    },
  )

  server.tool(
    'sync_folder',
    'Synchronize a folder from the mail server into the local cache (fetches new message envelopes).',
    { account_id: z.string().optional(), folder: z.string().describe('Folder path, e.g. INBOX') },
    async ({ account_id, folder }) => {
      try {
        const ctx = getCtx()
        const accountId = account_id ?? (await defaultAccountId(ctx, engine))
        return { content: [{ type: 'text' as const, text: json(await engine.syncFolder(ctx, accountId, folder)) }] }
      } catch (err) {
        toolError(err)
      }
    },
  )

  server.tool(
    'create_folder',
    'Create a real IMAP folder on the mail server (requires folder:write scope). System folders like INBOX cannot be created.',
    { account_id: z.string().optional(), path: z.string().min(1).describe('Folder path to create; use the server delimiter for nesting, e.g. Work/Projects') },
    async ({ account_id, path }) => {
      try {
        const ctx = getCtx()
        const accountId = account_id ?? (await defaultAccountId(ctx, engine))
        return { content: [{ type: 'text' as const, text: json(await engine.createFolder(ctx, accountId, path)) }] }
      } catch (err) {
        toolError(err)
      }
    },
  )

  server.tool(
    'rename_folder',
    'Rename a real IMAP folder on the mail server (requires folder:write scope). INBOX and system folders (Sent, Drafts, Trash…) cannot be renamed.',
    { account_id: z.string().optional(), path: z.string().min(1).describe('Existing folder path to rename'), new_path: z.string().min(1).describe('New folder path') },
    async ({ account_id, path, new_path }) => {
      try {
        const ctx = getCtx()
        const accountId = account_id ?? (await defaultAccountId(ctx, engine))
        return { content: [{ type: 'text' as const, text: json(await engine.renameFolder(ctx, accountId, path, new_path)) }] }
      } catch (err) {
        toolError(err)
      }
    },
  )

  server.tool(
    'delete_folder',
    'Delete a real IMAP folder on the mail server (requires folder:delete scope). INBOX and system folders are protected; deleting a folder that still contains messages requires confirm=true.',
    {
      account_id: z.string().optional(),
      path: z.string().min(1).describe('Folder path to delete'),
      confirm: z.boolean().optional().default(false).describe('Required true when the folder still contains messages'),
    },
    async ({ account_id, path, confirm }) => {
      try {
        const ctx = getCtx()
        const accountId = account_id ?? (await defaultAccountId(ctx, engine))
        return { content: [{ type: 'text' as const, text: json(await engine.deleteFolder(ctx, accountId, path, { confirm })) }] }
      } catch (err) {
        toolError(err)
      }
    },
  )

  server.tool(
    'list_messages',
    'List messages in a folder (cached view; auto-syncs when stale).',
    {
      account_id: z.string().optional(),
      folder: z.string().default('INBOX'),
      limit: z.number().int().min(1).max(100).default(30),
      filter: z.enum(['all', 'unseen', 'flagged', 'attachments']).optional(),
      q: z.string().optional().describe('Full-text query within the folder'),
      sync: z.boolean().optional().default(true).describe('Trigger a server sync when the cache is stale'),
    },
    async ({ account_id, folder, limit, filter, q, sync }) => {
      try {
        const ctx = getCtx()
        const accountId = account_id ?? (await defaultAccountId(ctx, engine))
        const res = await engine.listMessages(ctx, accountId, { folder, limit, filter, q, sync })
        return { content: [{ type: 'text' as const, text: json(res) }] }
      } catch (err) {
        toolError(err)
      }
    },
  )

  server.tool(
    'search_messages',
    'Full-text search across cached folders of the user (or one account).',
    { query: z.string().min(1), account_id: z.string().optional(), limit: z.number().int().min(1).max(200).default(50) },
    async ({ query, account_id, limit }) => {
      try {
        const ctx = getCtx()
        return { content: [{ type: 'text' as const, text: json(engine.searchMessages(ctx, { accountId: account_id, query, limit })) }] }
      } catch (err) {
        toolError(err)
      }
    },
  )

  server.tool(
    'get_message',
    'Fetch one full message (body text, sanitized HTML metadata, attachments list). Marks it as seen unless mark_seen=false.',
    {
      account_id: z.string().optional(),
      folder: z.string(),
      uid: z.number().int().min(1),
      mark_seen: z.boolean().optional().default(true),
    },
    async ({ account_id, folder, uid, mark_seen }) => {
      try {
        const ctx = getCtx()
        const accountId = account_id ?? (await defaultAccountId(ctx, engine))
        const detail = await engine.getMessage(ctx, accountId, folder, uid, { markSeen: mark_seen })
        return { content: [{ type: 'text' as const, text: json({ ...detail, bodyHtml: detail.bodyHtml ? '(sanitized html available via web UI)' : null }) }] }
      } catch (err) {
        toolError(err)
      }
    },
  )

  server.tool(
    'summarize_message',
    'AI summary of a message (requires ai:use scope and AI configuration).',
    { account_id: z.string().optional(), folder: z.string(), uid: z.number().int().min(1) },
    async ({ account_id, folder, uid }) => {
      try {
        const ctx = getCtx()
        const accountId = account_id ?? (await defaultAccountId(ctx, engine))
        return { content: [{ type: 'text' as const, text: (await aiService.summarize(ctx, accountId, folder, uid)).summary }] }
      } catch (err) {
        toolError(err)
      }
    },
  )

  server.tool(
    'draft_reply',
    'AI-drafted reply to a message (requires ai:use scope). The draft is a proposal; sending still requires the mail:send scope and an explicit send_message call.',
    { account_id: z.string().optional(), folder: z.string(), uid: z.number().int().min(1), instructions: z.string().optional().describe('Optional tone/content instructions') },
    async ({ account_id, folder, uid, instructions }) => {
      try {
        const ctx = getCtx()
        const accountId = account_id ?? (await defaultAccountId(ctx, engine))
        return { content: [{ type: 'text' as const, text: (await aiService.draftReply(ctx, accountId, folder, uid, instructions)).draft }] }
      } catch (err) {
        toolError(err)
      }
    },
  )

  server.tool(
    'create_draft',
    'Create a new IMAP draft (recipient, subject, content) saved in the account Drafts folder with the \\Draft flag — no prior message needed and NOTHING is sent. The draft is visible and editable in HermodMail or any other mail client. Requires the mail:write scope. To reply within an existing conversation, pass in_reply_to/references from the message being answered.',
    {
      account_id: z.string().optional(),
      to: z.array(addressSchema).optional().describe('Recipients (at least one recommended)'),
      cc: z.array(addressSchema).optional(),
      bcc: z.array(addressSchema).optional(),
      subject: z.string().optional(),
      text: z.string().optional().describe('Plain-text body of the draft'),
      html: z.string().optional().describe('HTML body (a text fallback is derived automatically)'),
      in_reply_to: z.string().optional().describe('Message-Id being replied to (optional, for conversation threading)'),
      references: z.array(z.string()).optional().describe('References chain, message ids (optional)'),
    },
    async ({ account_id, to, cc, bcc, subject, text, html, in_reply_to, references }) => {
      try {
        const ctx = getCtx()
        const accountId = account_id ?? (await defaultAccountId(ctx, engine))
        const res = await engine.saveDraft(ctx, {
          accountId,
          to,
          cc,
          bcc,
          subject,
          text,
          html,
          inReplyTo: in_reply_to,
          references,
        })
        return { content: [{ type: 'text' as const, text: json(res) }] }
      } catch (err) {
        toolError(err)
      }
    },
  )

  server.tool(
    'send_message',
    'Send an email through the account SMTP server (requires mail:send scope). The message is also appended to the Sent folder.',
    {
      account_id: z.string().optional(),
      to: z.array(addressSchema).min(1),
      cc: z.array(addressSchema).optional(),
      bcc: z.array(addressSchema).optional(),
      subject: z.string(),
      text: z.string().optional(),
      html: z.string().optional(),
      in_reply_to: z.string().optional().describe('Message-Id being replied to'),
    },
    async ({ account_id, to, cc, bcc, subject, text, html, in_reply_to }) => {
      try {
        const ctx = getCtx()
        const accountId = account_id ?? (await defaultAccountId(ctx, engine))
        const res = await engine.sendMessage(ctx, {
          accountId,
          to,
          cc,
          bcc,
          subject,
          text,
          html,
          inReplyTo: in_reply_to,
        })
        return { content: [{ type: 'text' as const, text: json(res) }] }
      } catch (err) {
        toolError(err)
      }
    },
  )

  server.tool(
    'mark_message',
    'Mark a message as seen/unseen or flagged/unflagged (requires mail:write scope).',
    { account_id: z.string().optional(), folder: z.string(), uid: z.number().int().min(1), seen: z.boolean().optional(), flagged: z.boolean().optional() },
    async ({ account_id, folder, uid, seen, flagged }) => {
      try {
        const ctx = getCtx()
        const accountId = account_id ?? (await defaultAccountId(ctx, engine))
        const detail = await engine.patchMessage(ctx, accountId, folder, uid, { seen, flagged })
        return { content: [{ type: 'text' as const, text: json({ seen: detail.seen, flagged: detail.flagged }) }] }
      } catch (err) {
        toolError(err)
      }
    },
  )

  server.tool(
    'move_message',
    'Move a message to another folder (requires mail:write scope).',
    { account_id: z.string().optional(), folder: z.string(), uid: z.number().int().min(1), to: z.string().describe('Destination folder path') },
    async ({ account_id, folder, uid, to }) => {
      try {
        const ctx = getCtx()
        const accountId = account_id ?? (await defaultAccountId(ctx, engine))
        await engine.moveMessage(ctx, accountId, folder, uid, to)
        return { content: [{ type: 'text' as const, text: 'moved' }] }
      } catch (err) {
        toolError(err)
      }
    },
  )

  server.tool(
    'delete_message',
    'Delete a message: moves it to Trash, or expunges it when already in Trash (requires mail:delete scope).',
    { account_id: z.string().optional(), folder: z.string(), uid: z.number().int().min(1) },
    async ({ account_id, folder, uid }) => {
      try {
        const ctx = getCtx()
        const accountId = account_id ?? (await defaultAccountId(ctx, engine))
        await engine.deleteMessage(ctx, accountId, folder, uid)
        return { content: [{ type: 'text' as const, text: 'deleted' }] }
      } catch (err) {
        toolError(err)
      }
    },
  )

  server.tool(
    'export_markdown',
    'Export a message as Markdown (subject, headers, body, AI summary if any).',
    { account_id: z.string().optional(), folder: z.string(), uid: z.number().int().min(1) },
    async ({ account_id, folder, uid }) => {
      try {
        const ctx = getCtx()
        const accountId = account_id ?? (await defaultAccountId(ctx, engine))
        return { content: [{ type: 'text' as const, text: await engine.exportMarkdown(ctx, accountId, folder, uid) }] }
      } catch (err) {
        toolError(err)
      }
    },
  )

  return server
}

async function defaultAccountId(ctx: AuthContext, engine: MailEngine): Promise<string> {
  const accounts = engine.listAccounts(ctx)
  if (!accounts.length) throw new McpError(ErrorCode.InvalidRequest, 'No mail account is configured for this user yet')
  return accounts[0]!.id
}

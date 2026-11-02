import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import cookie from '@fastify/cookie'
import fs from 'node:fs'
import path from 'node:path'
import { AppError, unauthorized } from '../core/errors.js'
import type { AuthContext } from '../core/types.js'
import type { AuthService } from '../core/auth-service.js'

declare module 'fastify' {
  interface FastifyRequest {
    ctx: AuthContext | null
  }
}

export const SESSION_COOKIE = 'hm_session'

export interface AppDeps {
  auth: AuthService
  webDist: string | undefined
}

/** Resolve the request identity: Bearer token first (agents/API), then session cookie (web). */
export function resolveContext(auth: AuthService, req: FastifyRequest): AuthContext | null {
  const header = req.headers.authorization
  if (header?.startsWith('Bearer ')) {
    return auth.contextForToken(header.slice(7).trim())
  }
  return auth.contextForSession(req.cookies[SESSION_COOKIE])
}

export async function buildApp(deps: AppDeps & { trustProxy?: boolean }): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      transport: process.env.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
    },
    bodyLimit: 25 * 1024 * 1024,
    trustProxy: deps.trustProxy ?? false,
  })

  await app.register(cookie, {})

  app.addHook('onRequest', async (req) => {
    req.ctx = resolveContext(deps.auth, req)
    // CSRF defense in depth: /api mutations without a Bearer token must be
    // same-origin when the browser declares an Origin. Bearer requests are
    // immune (tokens are never attached by browsers automatically) and
    // server-to-server clients simply send no Origin header.
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      req.url.startsWith('/api') &&
      !req.headers.authorization?.startsWith('Bearer ')
    ) {
      const origin = req.headers.origin
      if (origin) {
        let sameHost = false
        try {
          sameHost = new URL(origin).host === req.headers.host
        } catch {
          sameHost = false
        }
        if (!sameHost) throw new AppError('forbidden', 'Cross-origin request rejected')
      }
    }
  })

  // Security headers for the web client.
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.url.startsWith('/api') || req.url.startsWith('/mcp')) return payload
    reply.header('content-security-policy', [
      "default-src 'self'",
      "img-src 'self' https: http: data:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'",
      "connect-src 'self'",
      "frame-src 'self'",
      "frame-ancestors 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '))
    reply.header('x-content-type-options', 'nosniff')
    reply.header('referrer-policy', 'no-referrer')
    reply.header('x-frame-options', 'DENY')
    return payload
  })

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details ?? null } })
      return
    }
    // Fastify client errors (validation, empty JSON body, unsupported media
    // type, malformed cookies…): surface their real status, never a 500.
    const anyErr: { statusCode?: number } = err as { statusCode?: number }
    if (typeof anyErr.statusCode === 'number' && anyErr.statusCode >= 400 && anyErr.statusCode < 500) {
      const msg = err instanceof Error ? err.message : 'Invalid request'
      reply.status(anyErr.statusCode).send({ error: { code: 'bad_request', message: msg, details: null } })
      return
    }
    req.log.error(err, 'unhandled error')
    reply.status(500).send({ error: { code: 'internal', message: 'Internal server error', details: null } })
  })

  // ----- static web client (production) -----
  if (deps.webDist && fs.existsSync(path.join(deps.webDist, 'index.html'))) {
    const { default: fastifyStatic } = await import('@fastify/static')
    await app.register(fastifyStatic, {
      root: deps.webDist,
      prefix: '/',
      // Dynamic resolution: a web build deployed after server start must be
      // served without a restart (hashed filenames change every build).
      wildcard: true,
      immutable: true,
      maxAge: '1h',
      setHeaders: (res: unknown, filePath: string) => {
        if (filePath.endsWith('index.html')) (res as { setHeader: (k: string, v: string) => void }).setHeader('cache-control', 'no-cache')
      },
    })
    app.setNotFoundHandler(async (req, reply) => {
      if (req.method !== 'GET' || req.url.startsWith('/api') || req.url.startsWith('/mcp')) {
        reply.status(404).send({ error: { code: 'not_found', message: 'Not found', details: null } })
        return
      }
      // Never fall back to index.html for missing assets — that produces
      // MIME-type errors in the browser; only SPA routes get the shell.
      if (req.url.startsWith('/assets/') || /\.[a-zA-Z0-9]+$/.test(req.url.split('?')[0] ?? '')) {
        reply.status(404).send({ error: { code: 'not_found', message: 'Asset not found', details: null } })
        return
      }
      reply.header('cache-control', 'no-cache')
      return reply.sendFile('index.html')
    })
  }

  return app
}

export function requireAuth(req: FastifyRequest): AuthContext {
  if (!req.ctx) throw unauthorized()
  return req.ctx
}

export function noStore(reply: FastifyReply): FastifyReply {
  return reply.header('cache-control', 'no-store')
}

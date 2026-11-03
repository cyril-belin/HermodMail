import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/http/app.js'
import type { AuthService } from '../src/core/auth-service.js'

/**
 * Non-regression harness for the static web client path.
 *
 * The dependency remediation bumped @fastify/static 8 → 10. Under our
 * `wildcard: true` configuration the plugin registers a single `prefix + *`
 * route whose handler resolves files at request time (pumpSendToReply/send),
 * so a web build deployed after server start is served without a restart —
 * the production contract documented in http/app.ts. (The glob-based route
 * preloading only runs in `wildcard: false` mode; the glob 14 override
 * exists to keep the declared dependency audit-clean.)
 *
 * These tests pin the serving contract the web client relies on: hashed
 * assets, assets deployed after startup, SPA fallback, 404 for missing
 * assets, cache headers and the security headers applied outside /api /mcp.
 */

const dist = mkdtempSync(path.join(tmpdir(), 'hermodmail-static-'))
const auth = {
  contextForToken: () => null,
  contextForSession: () => null,
} as unknown as AuthService

let app: Awaited<ReturnType<typeof buildApp>>
let base: string

beforeAll(async () => {
  writeFileSync(path.join(dist, 'index.html'), '<!doctype html><html><body><div id=app></div></body></html>')
  writeFileSync(path.join(dist, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  mkdirSync(path.join(dist, 'assets'), { recursive: true })
  mkdirSync(path.join(dist, path.join('assets', 'deep')), { recursive: true })
  writeFileSync(path.join(dist, 'assets', 'app-h4sh3d.js'), 'console.log("hermodmail")')
  writeFileSync(path.join(dist, path.join('assets', 'deep', 'x.css')), 'body{margin:0}')

  app = await buildApp({ auth, webDist: dist })
  await app.listen({ port: 0, host: '127.0.0.1' })
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`
})

afterAll(async () => {
  await app.close()
  rmSync(dist, { recursive: true, force: true })
})

describe('static serving (@fastify/static 10, wildcard: true)', () => {
  it('serves index.html at / with no-cache (setHeaders override)', async () => {
    const res = await fetch(`${base}/`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(res.headers.get('cache-control')).toBe('no-cache')
    expect(await res.text()).toContain('id=app')
  })

  it('serves hashed assets, including nested files', async () => {
    const js = await fetch(`${base}/assets/app-h4sh3d.js`)
    expect(js.status).toBe(200)
    expect(js.headers.get('content-type')).toContain('javascript')
    expect(await js.text()).toContain('hermodmail')

    const css = await fetch(`${base}/assets/deep/x.css`)
    expect(css.status).toBe(200)
    expect(css.headers.get('content-type')).toContain('text/css')
  })

  it('serves the SPA shell for client routes without a file extension', async () => {
    const res = await fetch(`${base}/settings`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('id=app')
  })

  it('returns a JSON 404 for missing assets instead of the SPA shell', async () => {
    const res = await fetch(`${base}/assets/missing-9f8e7.js`)
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('not_found')
  })

  it('serves assets written to dist after server start (deploy without restart)', async () => {
    // Production contract (http/app.ts): a web build deployed after server
    // start must be served without a restart — hashed filenames change on
    // every build. wildcard:true resolves files at request time, unlike the
    // glob-preloaded routes of wildcard:false.
    const lateAsset = path.join(dist, 'assets', 'app-depl0yed.js')
    writeFileSync(lateAsset, 'console.log("deployed-after-start")')
    try {
      const res = await fetch(`${base}/assets/app-depl0yed.js`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('javascript')
      expect(await res.text()).toContain('deployed-after-start')
    } finally {
      rmSync(lateAsset, { force: true })
    }
  })

  it('applies the security headers to static responses and keeps JSON 404 for non-GET', async () => {
    const res = await fetch(`${base}/favicon.svg`)
    expect(res.status).toBe(200)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'")

    const post = await fetch(`${base}/favicon.svg`, { method: 'POST' })
    expect(post.status).toBe(404)
    const body = (await post.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('not_found')
  })
})

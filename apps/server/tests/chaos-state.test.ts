import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { openInMemoryDatabase, openDatabase, type DB } from '../src/db/database.js'
import { AuthService } from '../src/core/auth-service.js'
import { MailStore } from '../src/core/mail/store.js'
import { MailEngine } from '../src/core/mail/engine.js'
import { InMemoryTransport, FakeSmtpSender, makeRaw } from './inmemory-transport.js'
import type { Config } from '../src/config.js'
import type { AuthContext } from '../src/core/types.js'
import { SCOPES } from '../src/core/types.js'

const masterSecret = Buffer.from('c'.repeat(32))

function makeConfig(): Config {
  return { port: 0, host: '', dataDir: '', masterSecret, webDist: undefined, trustProxy: false, cookieSecure: false, sessionTtlHours: 1, initialSyncLimit: 50, bodyIndexLimit: 50, maxAttachmentSize: 1024 * 1024 }
}

interface World {
  db: DB
  auth: AuthService
  engine: MailEngine
  store: MailStore
  transport: InMemoryTransport
  web: AuthContext
  token: AuthContext
  accountId: string
}

async function makeWorld(): Promise<World> {
  const db = openInMemoryDatabase()
  const auth = new AuthService(db, 24)
  const store = new MailStore(db)
  const transport = new InMemoryTransport('me@example.com')
  const engine = new MailEngine(db, makeConfig(), store, async () => transport, new FakeSmtpSender().sender, () => {})
  auth.createUserGuarded({ email: 'o@x.test', password: 'password123' })
  const web = auth.contextForSession(auth.login('o@x.test', 'password123').token)!
  const { token: raw } = auth.createToken(web.userId, 'a', Object.values(SCOPES))
  const token = auth.contextForToken(raw)!
  const info = await engine.addAccount(web, {
    name: 'T', email: 'me@example.com',
    imap: { host: 'imap.chaos', port: 993, tls: 'tls', user: 'u', password: 'p' },
    smtp: { host: 'smtp.chaos', port: 587, tls: 'starttls' },
  })
  return { db, auth, engine, store, transport, web, token, accountId: info.id }
}

describe('Round 6 — SQLite under real concurrency and interruption', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync('/tmp/hm-sqlite-') })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('two concurrent connections on one WAL file interleave writes without corruption', () => {
    const dbPath = path.join(dir, 'conc.sqlite')
    const db1 = new Database(dbPath)
    const db2 = new Database(dbPath)
    db1.pragma('journal_mode = WAL')
    db2.pragma('journal_mode = WAL')
    db1.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
    // Interleave writes from two connections (better-sqlite3 is sync; this
    // exercises cross-connection locking + busy_timeout, the real deployment
    // pattern when two processes share the data dir).
    db2.pragma('busy_timeout = 5000')
    for (let i = 0; i < 200; i++) {
      db1.prepare('INSERT INTO t (v) VALUES (?)').run(`a${i}`)
      db2.prepare('INSERT INTO t (v) VALUES (?)').run(`b${i}`)
    }
    const total = (db1.prepare('SELECT COUNT(*) c FROM t').get() as { c: number }).c
    const integrity = (db1.pragma('integrity_check', { simple: true }) as string)
    expect(total).toBe(400)
    expect(integrity).toBe('ok')
    db1.close()
    db2.close()
  })

  it('survives SIGKILL of a writer process: committed data intact, integrity ok', async () => {
    const dbPath = path.join(dir, 'kill.sqlite')
    // Schema from a first healthy open
    const init = new Database(dbPath)
    init.pragma('journal_mode = WAL')
    init.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
    init.close()

    const child = spawn(process.execPath, ['-e', `
      const Database = require('better-sqlite3');
      const db = new Database(${JSON.stringify(dbPath)});
      db.pragma('busy_timeout = 5000');
      const ins = db.prepare('INSERT INTO t (v) VALUES (?)');
      let n = 0;
      const t0 = Date.now();
      while (Date.now() - t0 < 60000) { ins.run('x' + n); n++; }
    `], { cwd: path.join(import.meta.dirname, '..') })
    await new Promise((r) => setTimeout(r, 400))
    child.kill('SIGKILL') // hard kill mid-write bursts
    await new Promise((r) => child.once('exit', r))

    // Reopen: committed rows must survive, WAL must recover, integrity must pass.
    const db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    const count = (db.prepare('SELECT COUNT(*) c FROM t').get() as { c: number }).c
    expect(count).toBeGreaterThan(0)
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
    db.close()
  })

  it('app-level restart consistency: kill the server mid-request, data dir stays coherent', async () => {
    const dataDir = fs.mkdtempSync('/tmp/hm-restart-')
    try {
      const serverJs = path.join(dataDir, 'server.mjs')
      // Resolve the built server relative to this test file (the dist is
      // produced by `npm run build` before the tests) — never a machine-
      // specific absolute path, so the suite runs anywhere.
      fs.writeFileSync(serverJs, `
        process.env.PORT = '0';
        process.env.HOST = '127.0.0.1';
        import(${JSON.stringify(fileURLToPath(new URL('../dist/index.js', import.meta.url)))});
      `)
      const child = spawn(process.execPath, [serverJs], {
        env: { ...process.env, HERMODMAIL_DATA_DIR: dataDir, PORT: '8671', HOST: '127.0.0.1' },
        stdio: 'ignore',
      })
      await new Promise((r) => setTimeout(r, 1500))
      // Fire a setup request and kill the process mid-flight.
      const req = fetch('http://127.0.0.1:8671/api/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'a@b.co', password: 'password123' }),
      }).catch(() => null)
      await new Promise((r) => setTimeout(r, 30))
      child.kill('SIGKILL')
      await req
      // Reopen the database directly: no corruption, migrations at latest version.
      const db = new Database(path.join(dataDir, 'hermodmail.sqlite'))
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
      expect(db.pragma('user_version', { simple: true })).toBeGreaterThan(0)
      db.close()
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true })
    }
  }, 20000)
})

describe('Round 6 — MCP concurrency and revocation semantics', () => {
  let w: World
  beforeEach(async () => { w = await makeWorld() })

  it('two agent tokens operate concurrently on the same account without cross-talk', async () => {
    const { token: t1raw } = w.auth.createToken(w.web.userId, 'agent-1', [SCOPES.mailRead, SCOPES.mailWrite])
    const { token: t2raw } = w.auth.createToken(w.web.userId, 'agent-2', [SCOPES.mailRead])
    const t1 = w.auth.contextForToken(t1raw)!
    const t2 = w.auth.contextForToken(t2raw)!
    w.transport.deliver('INBOX', makeRaw({ subject: `Shared ${1}` }))
    w.transport.deliver('INBOX', makeRaw({ subject: `Shared ${2}` }))
    await w.engine.syncFolder(w.web, w.accountId, 'INBOX')
    // Interleaved operations from both agents
    const [r1, r2] = await Promise.all([
      w.engine.patchMessage(t1, w.accountId, 'INBOX', 1, { flagged: true }),
      w.engine.getMessage(t2, w.accountId, 'INBOX', 2, { markSeen: false }),
    ])
    expect(r1.flagged).toBe(true)
    expect(r2.seen).toBe(false)
    const list = await w.engine.listMessages(t2, w.accountId, { folder: 'INBOX', sync: false })
    expect(list.total).toBe(2)
  })

  it('token revocation takes effect at the next request; an in-flight context completes', async () => {
    const { token: raw } = w.auth.createToken(w.web.userId, 'ephemeral', [SCOPES.mailRead])
    const ctx = w.auth.contextForToken(raw)!
    w.transport.deliver('INBOX', makeRaw({ subject: 'x' }))
    await w.engine.syncFolder(w.web, w.accountId, 'INBOX')
    w.auth.revokeToken(w.web.userId, ctx.kind === 'token' ? (await w.auth.listTokens(w.web.userId)).find((t) => t.name === 'ephemeral')!.id : '')
    // The already-resolved context object still works for the in-flight call
    // (documented semantics: revocation is enforced per request, not mid-call).
    const inFlight = await w.engine.listMessages(ctx, w.accountId, { folder: 'INBOX', sync: false })
    expect(inFlight.total).toBe(1)
    // But a FRESH resolution of the same token is dead:
    expect(w.auth.contextForToken(raw)).toBeNull()
  })
})

describe('Round 6 — state transitions under faults', () => {
  let w: World
  beforeEach(async () => { w = await makeWorld() })

  it('folder lifecycle create→sync→rename→delete→recreate keeps the cache coherent', async () => {
    const folders1 = await w.engine.createFolder(w.token, w.accountId, 'Work')
    expect(folders1.map((f) => f.path)).toContain('Work')
    w.transport.deliver('Work', makeRaw({ subject: 'task' }))
    await w.engine.syncFolder(w.token, w.accountId, 'Work')
    expect((await w.engine.listMessages(w.token, w.accountId, { folder: 'Work', sync: false })).total).toBe(1)

    await w.engine.renameFolder(w.token, w.accountId, 'Work', 'Projects')
    const folders2 = await w.engine.listFolders(w.token, w.accountId)
    expect(folders2.map((f) => f.path)).toContain('Projects')
    expect(folders2.map((f) => f.path)).not.toContain('Work')
    // Old cache row gone; resync of the renamed folder repopulates it
    await w.engine.syncFolder(w.token, w.accountId, 'Projects')
    expect((await w.engine.listMessages(w.token, w.accountId, { folder: 'Projects', sync: false })).total).toBe(1)

    // Non-empty folders now require an explicit confirm (system-folder guard).
    await expect(w.engine.deleteFolder(w.token, w.accountId, 'Projects')).rejects.toThrowError(/confirm/)
    await w.engine.deleteFolder(w.token, w.accountId, 'Projects', { confirm: true })
    const folders3 = await w.engine.listFolders(w.token, w.accountId)
    expect(folders3.map((f) => f.path)).not.toContain('Projects')
    // Recreate: fresh cache, no leakage from the previous incarnation
    await w.engine.createFolder(w.token, w.accountId, 'Work')
    w.transport.deliver('Work', makeRaw({ subject: 'fresh' }))
    const list = await w.engine.listMessages(w.token, w.accountId, { folder: 'Work', sync: true })
    expect(list.messages.map((m) => m.subject)).toEqual(['fresh'])
  })

  it('sync interrupted mid-flight leaves the cache usable and re-syncable', async () => {
    w.transport.deliver('INBOX', makeRaw({ subject: 'A' }))
    w.transport.deliver('INBOX', makeRaw({ subject: 'B' }))
    // Sticky outage: BOTH the initial attempt and the automatic retry fail.
    w.transport.failNext = 'syncFolder'
    w.transport.failSticky = true
    await expect(w.engine.syncFolder(w.token, w.accountId, 'INBOX')).rejects.toThrow()
    // Cache is still queryable (empty), and once the outage ends the next sync succeeds
    expect((await w.engine.listMessages(w.token, w.accountId, { folder: 'INBOX', sync: false })).total).toBe(0)
    w.transport.failSticky = false
    w.transport.failNext = null
    const res = await w.engine.syncFolder(w.token, w.accountId, 'INBOX')
    expect(res.newMessages).toBe(2)
    expect((await w.engine.listMessages(w.token, w.accountId, { folder: 'INBOX', sync: false })).total).toBe(2)
  })
})

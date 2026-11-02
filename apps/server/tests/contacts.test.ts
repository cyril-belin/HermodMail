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
import type { Server } from 'node:http'

const masterSecret = Buffer.from('m'.repeat(32))

/**
 * Smart address book: automatic harvest from cached mail traffic (received AND
 * sent, including pre-existing history), manual CRUD and autocomplete.
 */
describe('Contacts', () => {
  let db: DB
  let engine: MailEngine
  let web: AuthContext
  let webB: AuthContext
  let tokenWrite: string
  let tokenRead: string
  let transport: InMemoryTransport
  let accountId: string
  
  let app: import('fastify').FastifyInstance
  let baseUrl: string
  let server: Server | undefined
  let accountIdB: string
  let transportsByHost: Map<string, InMemoryTransport>

  beforeAll(async () => {
    db = openInMemoryDatabase()
    const auth = new AuthService(db, 24)
    const store = new MailStore(db)
    const transports = new Map<string, InMemoryTransport>()
    transportsByHost = transports
    engine = new MailEngine(
      db,
      { port: 0, host: '', dataDir: '', masterSecret, webDist: undefined, trustProxy: false, sessionTtlHours: 1, initialSyncLimit: 50, bodyIndexLimit: 50, maxAttachmentSize: 100_000 } satisfies Config,
      store,
      async (cfg) => {
        let t = transports.get(cfg.host)
        if (!t) { t = new InMemoryTransport(cfg.user); transports.set(cfg.host, t) }
        return t
      },
      new FakeSmtpSender().sender,
      () => {},
    )
    transport = transports.get('imap.contacts') ?? new InMemoryTransport('me@contacts.test')
    transports.set('imap.contacts', transport)

    auth.createUserGuarded({ email: 'a@contacts.test', password: 'password123' })
    web = auth.contextForSession(auth.login('a@contacts.test', 'password123').token)!
    // Second user needs an admin actor (user A is admin as first user).
    auth.createUserGuarded({ email: 'b@contacts.test', password: 'password123' }, web)
    webB = auth.contextForSession(auth.login('b@contacts.test', 'password123').token)!

    tokenWrite = auth.createToken(web.userId, 'agent', Object.values(SCOPES)).token
    tokenRead = auth.createToken(web.userId, 'ro', [SCOPES.mailRead]).token

    accountId = (await engine.addAccount(web, {
      name: 'Me', email: 'me@contacts.test',
      imap: { host: 'imap.contacts', port: 993, tls: 'tls', user: 'me@contacts.test', password: 'p' },
      smtp: { host: 'smtp.contacts', port: 587, tls: 'starttls' },
    })).id
    accountIdB = (await engine.addAccount(webB, {
      name: 'Other', email: 'other@contacts.test',
      imap: { host: 'imap.other', port: 993, tls: 'tls', user: 'other@contacts.test', password: 'p' },
      smtp: { host: 'smtp.other', port: 587, tls: 'starttls' },
    })).id
    const app = await buildApp({ auth, webDist: undefined })
    registerRoutes(app, { auth, engine, aiRegistry: {} as never, aiService: {} as never, secureCookies: false })
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

  it('migration v3 created the contacts and app_meta tables', () => {
    // v4 (locale + translations) has since been added on top of v3.
    expect(db.pragma('user_version', { simple: true })).toBeGreaterThanOrEqual(3)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='contacts'").get()).toBeTruthy()
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='app_meta'").get()).toBeTruthy()
  })

  it('harvests senders and recipients from a synced folder, excluding self', async () => {
    transport.deliver('INBOX', Buffer.from(
      `From: Alice Example <Alice@Example.com>\r\nTo: me@contacts.test\r\nCc: Carol <carol@example.com>\r\nSubject: hi\r\nDate: ${new Date('2026-01-10T10:00:00Z').toUTCString()}\r\nMessage-ID: <c1@example.com>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nhello\r\n`,
    ))
    await engine.syncFolder(web, accountId, 'INBOX')
    const contacts = engine.listContacts(web, {})
    const emails = contacts.map((c) => c.email)
    expect(emails).toContain('alice@example.com')
    expect(emails).toContain('carol@example.com')
    expect(emails).not.toContain('me@contacts.test')
    const alice = contacts.find((c) => c.email === 'alice@example.com')!
    expect(alice.name).toBe('Alice Example')
    expect(alice.source).toBe('auto')
    expect(alice.messageCount).toBe(1)
    expect(alice.lastMessageAt).toBe(Date.parse('2026-01-10T10:00:00Z'))
  })

  it('harvests recipients of sent mail (other direction)', async () => {
    transport.deliver('Sent', Buffer.from(
      `From: me@contacts.test\r\nTo: Bob <bob@example.com>\r\nSubject: re: hi\r\nDate: ${new Date('2026-01-11T10:00:00Z').toUTCString()}\r\nMessage-ID: <c2@example.com>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nanswering\r\n`,
    ))
    await engine.syncFolder(web, accountId, 'Sent')
    const bob = engine.listContacts(web, {}).find((c) => c.email === 'bob@example.com')
    expect(bob).toBeTruthy()
    expect(bob!.name).toBe('Bob')
  })

  it('ranks the list by frequency then recency', async () => {
    transport.deliver('INBOX', Buffer.from(
      `From: alice@example.com\r\nTo: me@contacts.test\r\nSubject: again\r\nDate: ${new Date('2026-01-12T10:00:00Z').toUTCString()}\r\nMessage-ID: <c3@example.com>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nagain\r\n`,
    ))
    await engine.syncFolder(web, accountId, 'INBOX')
    const list = engine.listContacts(web, {})
    const alice = list.find((c) => c.email === 'alice@example.com')!
    expect(alice.messageCount).toBe(2)
    expect(alice.lastMessageAt).toBe(Date.parse('2026-01-12T10:00:00Z'))
    // alice (2 messages) ranks before bob and carol (1)
    expect(list.findIndex((c) => c.email === 'alice@example.com')).toBeLessThan(list.findIndex((c) => c.email === 'bob@example.com'))
  })

  it('autocompletes: prefix matches first, substring second, empty query = most frequent', () => {
    engine.createContact(web, { email: 'dave.smith@example.com', name: 'Dave Smith' })
    const s1 = engine.suggestContacts(web, 'ali')
    expect(s1[0]!.email).toBe('alice@example.com') // prefix on email
    const s2 = engine.suggestContacts(web, 'smith')
    expect(s2.some((c) => c.email === 'dave.smith@example.com')).toBe(true) // substring match still found
    const s3 = engine.suggestContacts(web, '')
    expect(s3[0]!.email).toBe('alice@example.com') // most frequent first
    expect(s3.length).toBeLessThanOrEqual(8)
  })

  it('manual contacts keep their name when mail is harvested later', async () => {
    engine.createContact(web, { email: 'manual@example.com', name: 'M. Manual' })
    transport.deliver('INBOX', Buffer.from(
      `From: Manual Person <manual@example.com>\r\nTo: me@contacts.test\r\nSubject: signature change\r\nDate: ${new Date('2026-01-13T10:00:00Z').toUTCString()}\r\nMessage-ID: <c4@example.com>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nnow Robert\r\n`,
    ))
    await engine.syncFolder(web, accountId, 'INBOX')
    const manual = engine.listContacts(web, {}).find((c) => c.email === 'manual@example.com')!
    expect(manual.name).toBe('M. Manual')
    expect(manual.source).toBe('manual')
    expect(manual.messageCount).toBe(1) // frequency still tracked
    // While auto contacts DO pick up new display names:
    const alice = engine.listContacts(web, {}).find((c) => c.email === 'alice@example.com')!
    expect(alice.name).toBe('Alice Example')
  })

  it('CRUD via HTTP: create, duplicate 409, update, list, delete', async () => {
    const h = { 'content-type': 'application/json', authorization: `Bearer ${tokenWrite}` }
    const created = await fetch(`${baseUrl}/api/contacts`, { method: 'POST', headers: h, body: JSON.stringify({ email: 'Eve@Example.COM', name: 'Eve' }) })
    expect(created.status).toBe(200)
    const contact = ((await created.json()) as { contact: { id: string; email: string; source: string } }).contact
    expect(contact.email).toBe('eve@example.com')
    expect(contact.source).toBe('manual')

    const dup = await fetch(`${baseUrl}/api/contacts`, { method: 'POST', headers: h, body: JSON.stringify({ email: 'eve@example.com' }) })
    expect(dup.status).toBe(409)

    const bad = await fetch(`${baseUrl}/api/contacts`, { method: 'POST', headers: h, body: JSON.stringify({ email: 'not-an-email' }) })
    expect(bad.status).toBe(400)

    const patched = await fetch(`${baseUrl}/api/contacts/${contact.id}`, { method: 'PATCH', headers: h, body: JSON.stringify({ name: 'Eve Adams' }) })
    expect(patched.status).toBe(200)
    expect(((await patched.json()) as { contact: { name: string } }).contact.name).toBe('Eve Adams')

    const listed = await fetch(`${baseUrl}/api/contacts`, { headers: { authorization: `Bearer ${tokenWrite}` } })
    const list = ((await listed.json()) as { contacts: { email: string }[] }).contacts
    expect(list.some((c) => c.email === 'eve@example.com')).toBe(true)

    // No content-type on the bodyless DELETE: Fastify would try to parse an
    // empty JSON body and reject it.
    const removed = await fetch(`${baseUrl}/api/contacts/${contact.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${tokenWrite}` } })
    expect(removed.status).toBe(200)
    const after = await fetch(`${baseUrl}/api/contacts`, { headers: { authorization: `Bearer ${tokenWrite}` } })
    expect((((await after.json()) as { contacts: { email: string }[] }).contacts).some((c) => c.email === 'eve@example.com')).toBe(false)
  })

  it('suggest endpoint answers autocomplete queries', async () => {
    const res = await fetch(`${baseUrl}/api/contacts/suggest?q=caro`, { headers: { authorization: `Bearer ${tokenWrite}` } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { contacts: { email: string }[] }
    expect(body.contacts.some((c) => c.email === 'carol@example.com')).toBe(true)
  })

  it('scopes: a token without mail:write cannot create/update/delete contacts', () => {
    expect(() => engine.createContact({ ...web, kind: 'token', scopes: new Set([SCOPES.mailRead]) }, { email: 'x@y.co' })).toThrow(/mail:write/)
    expect(() => engine.suggestContacts({ ...web, kind: 'token', scopes: new Set([SCOPES.mailRead]) }, 'a')).not.toThrow()
  })

  it('isolation: user B never sees or mutates user A contacts', async () => {
    // B's own address book is empty (A's contacts are not leaked)
    expect(engine.listContacts(webB, {})).toHaveLength(0)
    // A has contacts; taking one of their ids does not authorize B
    const alice = engine.listContacts(web, {}).find((c) => c.email === 'alice@example.com')!
    expect(() => engine.updateContact(webB, alice.id, { name: 'hijacked' })).toThrow(/not found/i)
    expect(() => engine.deleteContact(webB, alice.id)).toThrow(/not found/i)
    expect(engine.listContacts(web, {}).find((c) => c.email === 'alice@example.com')!.name).toBe('Alice Example')
  })

  it('isolation: syncs of user B never pollute user A contacts', async () => {
    const tB = transportsByHost.get('imap.other')!
    tB.deliver('INBOX', Buffer.from(
      `From: Private <private@b.test>\r\nTo: other@contacts.test\r\nSubject: b only\r\nDate: ${new Date('2026-01-14T10:00:00Z').toUTCString()}\r\nMessage-ID: <b1@b.test>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nhi\r\n`,
    ))
    await engine.syncFolder(webB, accountIdB, 'INBOX')
    // B harvested their own correspondent…
    expect(engine.listContacts(webB, {}).some((c) => c.email === 'private@b.test')).toBe(true)
    // …and A sees neither B's correspondent nor B's view of the world.
    expect(engine.listContacts(web, {}).some((c) => c.email === 'private@b.test')).toBe(false)
    expect(engine.listContacts(webB, {}).some((c) => c.email === 'alice@example.com')).toBe(false)
  })

  it('backfill harvests already-cached history exactly once', async () => {
    // Simulate an upgrade: contacts exist from sync harvests; clear the flag
    // and the table, then backfill must rebuild the same book (no duplicates).
    db.prepare('DELETE FROM app_meta').run()
    db.prepare('DELETE FROM contacts').run()
    const first = engine.backfillContactsOnce()
    expect(first).toBeGreaterThan(0)
    const alice = engine.listContacts(web, {}).find((c) => c.email === 'alice@example.com')!
    expect(alice).toBeTruthy()
    expect(alice.messageCount).toBeGreaterThanOrEqual(2)
    // Second run is a no-op (flag set).
    const second = engine.backfillContactsOnce()
    expect(second).toBe(0)
    expect(engine.listContacts(web, {}).find((c) => c.email === 'alice@example.com')!.messageCount).toBe(alice.messageCount)
  })

  it('token without mail:write gets 403 from the write routes', async () => {
    const h = { 'content-type': 'application/json', authorization: `Bearer ${tokenRead}` }
    const res = await fetch(`${baseUrl}/api/contacts`, { method: 'POST', headers: h, body: JSON.stringify({ email: 'x@y.co' }) })
    expect(res.status).toBe(403)
    const res2 = await fetch(`${baseUrl}/api/contacts`, { headers: { authorization: `Bearer ${tokenWrite}` } })
    expect(res2.status).toBe(200)
  })
})

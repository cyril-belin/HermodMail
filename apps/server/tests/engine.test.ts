import { beforeEach, describe, expect, it } from 'vitest'
import { openInMemoryDatabase, type DB } from '../src/db/database.js'
import { AuthService } from '../src/core/auth-service.js'
import { MailStore } from '../src/core/mail/store.js'
import { MailEngine } from '../src/core/mail/engine.js'
import { InMemoryTransport, FakeSmtpSender, makeRaw } from './inmemory-transport.js'
import type { Config } from '../src/config.js'
import type { AuthContext } from '../src/core/types.js'
import { SCOPES } from '../src/core/types.js'
import { forbidden } from '../src/core/errors.js'

const masterSecret = Buffer.from('t'.repeat(32))

function makeConfig(): Config {
  return {
    port: 0, host: '127.0.0.1', dataDir: '/tmp/unused', masterSecret, webDist: undefined,
    trustProxy: false, sessionTtlHours: 1, initialSyncLimit: 50, bodyIndexLimit: 50, maxAttachmentSize: 1024 * 1024,
  }
}

interface World {
  db: DB
  engine: MailEngine
  auth: AuthService
  store: MailStore
  smtp: FakeSmtpSender
  transports: Map<string, InMemoryTransport>
  web: AuthContext
  token: AuthContext
}

function makeWorld(): World {
  const db = openInMemoryDatabase()
  const auth = new AuthService(db, 24)
  const store = new MailStore(db)
  const transports = new Map<string, InMemoryTransport>()
  const smtp = new FakeSmtpSender()
  const engine = new MailEngine(
    db, makeConfig(), store,
    async (cfg) => {
      let t = transports.get(cfg.host)
      if (!t) {
        t = new InMemoryTransport(cfg.user)
        transports.set(cfg.host, t)
      }
      return t
    },
    smtp.sender,
    () => {},
  )

  auth.createUserGuarded({ email: 'owner@x.test', password: 'password123' })
  const web = auth.contextForSession(auth.login('owner@x.test', 'password123').token)!
  const { token: rawToken } = auth.createToken(web.userId, 'agent', [SCOPES.mailRead, SCOPES.mailWrite, SCOPES.mailSend, SCOPES.mailDelete])
  const token = auth.contextForToken(rawToken)!
  return { db, engine, auth, store, smtp, transports, web, token }
}

async function addAccount(w: World, host = 'imap.test'): Promise<string> {
  const info = await w.engine.addAccount(w.web, {
    name: 'Test', email: 'me@example.com',
    imap: { host, port: 993, tls: 'tls', user: 'me@example.com', password: 'secret' },
    smtp: { host: 'smtp.test', port: 587, tls: 'starttls', user: 'me@example.com', password: 'secret' },
  })
  return info.id
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('MailEngine with in-memory transport', () => {
  let w: World
  beforeEach(() => { w = makeWorld() })

  it('adds an account and primes the folder cache', async () => {
    const id = await addAccount(w)
    const folders = await w.engine.listFolders(w.web, id)
    expect(folders.map((f) => f.path)).toEqual(['INBOX', 'Sent', 'Trash'])
  })

  it('syncs envelopes, lists newest-first, and fetches full bodies with real MIME parsing', async () => {
    const id = await addAccount(w)
    const transport = w.transports.get('imap.test')!
    transport.deliver('INBOX', makeRaw({ subject: 'Old', text: 'first body', html: '<p>first <b>body</b><script>x()</script></p>' }))
    transport.deliver('INBOX', makeRaw({ subject: 'New', from: 'Carol <carol@example.com>', text: 'second body' }))
    const sync = await w.engine.syncFolder(w.web, id, 'INBOX')
    expect(sync.newMessages).toBe(2)

    const list = await w.engine.listMessages(w.token, id, { folder: 'INBOX', sync: false })
    expect(list.messages.map((m) => m.subject)).toEqual(['New', 'Old'])
    expect(list.messages[0]!.from[0]!.email).toBe('carol@example.com')

    const detail = await w.engine.getMessage(w.token, id, 'INBOX', 2, { markSeen: false })
    expect(detail.subject).toBe('New')
    expect(detail.bodyText).toContain('second body')

    const first = await w.engine.getMessage(w.token, id, 'INBOX', 1, { markSeen: true })
    expect(first.bodyText).toContain('first body')
    expect(first.bodyHtml).not.toBeNull()
    expect(first.bodyHtml).not.toContain('<script')
    expect(first.bodyHtml).toContain('<b>body</b>')
    expect(first.seen).toBe(true)

    const after = await w.engine.listMessages(w.token, id, { folder: 'INBOX', sync: false, filter: 'unseen' })
    expect(after.total).toBe(1)
  })

  it('patches flags through to the server and local cache', async () => {
    const id = await addAccount(w)
    const transport = w.transports.get('imap.test')!
    const uid = transport.deliver('INBOX', makeRaw({ subject: 'Flag me' }))
    await w.engine.syncFolder(w.web, id, 'INBOX')
    await w.engine.patchMessage(w.token, id, 'INBOX', uid, { flagged: true, seen: true })
    const serverMsg = transport.messages.get('INBOX')!.find((m) => m.uid === uid)!
    expect(serverMsg.flags.has('\\Flagged')).toBe(true)
    expect(serverMsg.flags.has('\\Seen')).toBe(true)
  })

  it('moves delete-to-trash and expunges inside trash', async () => {
    const id = await addAccount(w)
    const transport = w.transports.get('imap.test')!
    const uid = transport.deliver('INBOX', makeRaw({ subject: 'Doomed' }))
    await w.engine.syncFolder(w.web, id, 'INBOX')
    await w.engine.deleteMessage(w.token, id, 'INBOX', uid)
    expect(transport.messages.get('INBOX')).toHaveLength(0)
    expect(transport.messages.get('Trash')).toHaveLength(1)
    // After a MOVE the destination UID is only known after a resync — like the UI does.
    await w.engine.syncFolder(w.token, id, 'Trash')
    const trashUid = transport.messages.get('Trash')![0]!.uid
    await w.engine.deleteMessage(w.token, id, 'Trash', trashUid)
    expect(transport.messages.get('Trash')).toHaveLength(0)
  })

  it('sends mail via SMTP, appends to Sent, and threads In-Reply-To', async () => {
    const id = await addAccount(w)
    const transport = w.transports.get('imap.test')!
    const res = await w.engine.sendMessage(w.token, {
      accountId: id,
      to: [{ email: 'dest@example.com', name: 'Dest' }],
      cc: [{ email: 'cc@example.com' }],
      subject: 'Answer',
      text: 'Here is my answer.',
      inReplyTo: 'orig@other.test',
    })
    expect(res.savedToSent).toBe(true)
    expect(w.smtp.sent).toHaveLength(1)
    expect(w.smtp.sent[0]!.to.sort()).toEqual(['cc@example.com', 'dest@example.com'])
    const raw = w.smtp.sent[0]!.raw.toString()
    expect(raw).toContain('Subject: Answer')
    expect(raw).toContain('In-Reply-To: <orig@other.test>')
    expect(raw).toContain('Here is my answer.')
    // Sent copy stored on IMAP
    expect(transport.messages.get('Sent')).toHaveLength(1)
    expect(transport.messages.get('Sent')![0]!.flags.has('\\Seen')).toBe(true)
  })

  it('rejects invalid recipients and empty bodies', async () => {
    const id = await addAccount(w)
    await expect(w.engine.sendMessage(w.token, { accountId: id, to: [{ email: 'not-an-email' }], subject: 'x', text: 'y' }))
      .rejects.toThrow(/recipient/i)
    await expect(w.engine.sendMessage(w.token, { accountId: id, to: [{ email: 'a@b.co' }], subject: 'x' }))
      .rejects.toThrow(/body/i)
  })

  it('enforces account ownership between users', async () => {
    const id = await addAccount(w)
    w.auth.createUser({ email: 'other@x.test', password: 'password123', isAdmin: false }, w.web)
    const other = w.auth.contextForSession(w.auth.login('other@x.test', 'password123').token)!
    await expect(w.engine.listFolders(other, id)).rejects.toThrowError(forbidden('x').constructor)
    await expect(w.engine.getMessage(other, id, 'INBOX', 1)).rejects.toThrowError(forbidden('x').constructor)
    // and simply cannot see the account at all
    expect(w.engine.listAccounts(other)).toHaveLength(0)
  })

  it('enforces scopes on token contexts', async () => {
    const id = await addAccount(w)
    // A read-only token belonging to the SAME user (scope test, not ownership test).
    const { token: roRaw } = w.auth.createToken(w.web.userId, 'ro-agent', [SCOPES.mailRead])
    const ro = w.auth.contextForToken(roRaw)!

    // read works
    const folders = await w.engine.listFolders(ro, id)
    expect(folders.length).toBeGreaterThan(0)
    // write is blocked by scope
    await expect(w.engine.patchMessage(ro, id, 'INBOX', 1, { seen: true }))
      .rejects.toThrowError(forbidden('x').constructor)
    await expect(w.engine.sendMessage(ro, { accountId: id, to: [{ email: 'a@b.co' }], subject: 's', text: 't' }))
      .rejects.toThrowError(forbidden('x').constructor)
    await expect(w.engine.deleteMessage(ro, id, 'INBOX', 1))
      .rejects.toThrowError(forbidden('x').constructor)
  })

  it('indexes bodies in the background so full-text search finds content', async () => {
    const id = await addAccount(w)
    const transport = w.transports.get('imap.test')!
    transport.deliver('INBOX', makeRaw({ subject: 'Quarterly report', text: 'The zebra directive ships in June.' }))
    await w.engine.syncFolder(w.web, id, 'INBOX')
    await waitFor(() => {
      const hits = w.engine.searchMessages(w.token, { query: 'zebra' })
      return hits.length === 1
    })
    const hits = w.engine.searchMessages(w.token, { query: 'zebra' })
    expect(hits[0]!.subject).toBe('Quarterly report')
    expect(w.engine.searchMessages(w.token, { query: 'nonexistentterm' })).toHaveLength(0)
  })

  it('detects uidvalidity change and clears stale cache', async () => {
    const id = await addAccount(w)
    const transport = w.transports.get('imap.test')!
    transport.deliver('INBOX', makeRaw({ subject: 'One' }))
    await w.engine.syncFolder(w.web, id, 'INBOX')

    // Simulate a server-side mailbox rebuild (new UIDVALIDITY).
    transport.rebuildMailbox()
    await w.engine.syncFolder(w.web, id, 'INBOX')
    const list = await w.engine.listMessages(w.token, id, { folder: 'INBOX', sync: false })
    expect(list.messages.map((m) => m.subject)).toEqual(['One'])
  })

  it('exports a message as Markdown', async () => {
    const id = await addAccount(w)
    const transport = w.transports.get('imap.test')!
    transport.deliver('INBOX', makeRaw({ subject: 'Export me', from: 'Ann <ann@example.com>', text: 'Body for export.' }))
    await w.engine.syncFolder(w.web, id, 'INBOX')
    const md = await w.engine.exportMarkdown(w.token, id, 'INBOX', 1)
    expect(md).toContain('# Export me')
    expect(md).toContain('**From:** Ann <ann@example.com>')
    expect(md).toContain('Body for export.')
  })
})

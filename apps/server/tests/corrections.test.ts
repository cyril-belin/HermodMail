/**
 * Regression tests for the five post-real-mailbox fixes:
 *  1. read/unread distinction + Seen reconciliation
 *  2. configurable refresh (persisted setting, no concurrent syncs)
 *  3. reply addressing (Reply-To, References, In-Reply-To)
 *  4. account editing without re-typing the password
 *  5. real folder counters (unread badge tracks actual unread messages)
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { openInMemoryDatabase, type DB } from '../src/db/database.js'
import { AuthService } from '../src/core/auth-service.js'
import { MailStore } from '../src/core/mail/store.js'
import { MailEngine, DEFAULT_REFRESH_INTERVAL_MS, REFRESH_INTERVALS_MS } from '../src/core/mail/engine.js'
import { InMemoryTransport, FakeSmtpSender, makeRaw } from './inmemory-transport.js'
import type { Config } from '../src/config.js'
import type { AuthContext } from '../src/core/types.js'
import { SCOPES } from '../src/core/types.js'
import { decryptSecret } from '../src/core/crypto.js'
import { badRequest } from '../src/core/errors.js'
import { sanitizeEmailHtml } from '../src/core/mail/sanitize.js'

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
  /** How many times the transport factory ran (probes included). */
  factoryCalls: number
}

function makeWorld(): World {
  const db = openInMemoryDatabase()
  const auth = new AuthService(db, 24)
  const store = new MailStore(db)
  const transports = new Map<string, InMemoryTransport>()
  const smtp = new FakeSmtpSender()
  const world: World = {
    db, engine: undefined as unknown as MailEngine, auth, store, smtp, transports,
    web: undefined as unknown as AuthContext, token: undefined as unknown as AuthContext, factoryCalls: 0,
  }
  world.engine = new MailEngine(
    db, makeConfig(), store,
    async (cfg) => {
      world.factoryCalls += 1
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
  world.web = auth.contextForSession(auth.login('owner@x.test', 'password123').token)!
  const { token: rawToken } = auth.createToken(world.web.userId, 'agent', [SCOPES.mailRead, SCOPES.mailWrite, SCOPES.mailSend, SCOPES.mailDelete])
  world.token = auth.contextForToken(rawToken)!
  return world
}

async function addAccount(w: World, host = 'imap.test'): Promise<string> {
  const info = await w.engine.addAccount(w.web, {
    name: 'Test', email: 'me@example.com',
    imap: { host, port: 993, tls: 'tls', user: 'me@example.com', password: 'secret' },
    smtp: { host: 'smtp.test', port: 587, tls: 'starttls', user: 'me@example.com', password: 'secret' },
  })
  return info.id
}

async function folderOf(w: World, accountId: string, path = 'INBOX') {
  return (await w.engine.listFolders(w.web, accountId)).find((f) => f.path === path)!
}

/** Sent mail headers as a lowercase-keyed record. */
function sentHeaders(raw: Buffer): Record<string, string> {
  const out: Record<string, string> = {}
  const head = raw.toString('utf8').split('\r\n\r\n')[0] ?? ''
  for (const line of head.split('\r\n')) {
    const idx = line.indexOf(':')
    if (idx > 0) out[line.slice(0, idx).toLowerCase()] = line.slice(idx + 1).trim()
  }
  return out
}

describe('read/unread state and folder counters', () => {
  let w: World
  let id: string
  let transport: InMemoryTransport

  beforeEach(async () => {
    w = makeWorld()
    id = await addAccount(w)
    transport = w.transports.get('imap.test')!
    transport.deliver('INBOX', makeRaw({ subject: 'One', text: 'first' }))
    transport.deliver('INBOX', makeRaw({ subject: 'Two', text: 'second' }))
    await w.engine.syncFolder(w.web, id, 'INBOX')
  })

  it('reading a message goes 2 unread → 1 → 0 and flips \\Seen on the server', async () => {
    expect((await folderOf(w, id)).unreadCount).toBe(2)
    await w.engine.getMessage(w.token, id, 'INBOX', 1, { markSeen: true })
    expect((await folderOf(w, id)).unreadCount).toBe(1)
    expect(transport.messages.get('INBOX')![0]!.flags.has('\\Seen')).toBe(true)
    await w.engine.getMessage(w.token, id, 'INBOX', 2, { markSeen: true })
    expect((await folderOf(w, id)).unreadCount).toBe(0)
    // And the unread filter agrees with the counter.
    const list = await w.engine.listMessages(w.token, id, { folder: 'INBOX', sync: false, filter: 'unseen' })
    expect(list.total).toBe(0)
  })

  it('marking read → unread goes back up and removes \\Seen server-side', async () => {
    await w.engine.getMessage(w.token, id, 'INBOX', 1, { markSeen: true })
    await w.engine.patchMessage(w.token, id, 'INBOX', 1, { seen: false })
    expect((await folderOf(w, id)).unreadCount).toBe(2)
    expect(transport.messages.get('INBOX')![0]!.flags.has('\\Seen')).toBe(false)
    const msg = await w.engine.getMessage(w.token, id, 'INBOX', 1, { markSeen: false })
    expect(msg.seen).toBe(false)
  })

  it('a change made by another IMAP client reconciles after sync', async () => {
    // Another client marks both messages read directly on the server.
    await transport.updateFlags('INBOX', 1, { add: ['\\Seen'] })
    await transport.updateFlags('INBOX', 2, { add: ['\\Seen'] })
    await w.engine.syncFolder(w.web, id, 'INBOX')
    expect((await folderOf(w, id)).unreadCount).toBe(0)
    const list = await w.engine.listMessages(w.token, id, { folder: 'INBOX', sync: false })
    expect(list.messages.every((m) => m.seen)).toBe(true)
  })

  it('move updates both folders\' counters, delete updates the target', async () => {
    await w.engine.createFolder(w.web, id, 'Archive')
    await w.engine.moveMessage(w.token, id, 'INBOX', 1, 'Archive')
    expect((await folderOf(w, id, 'INBOX')).totalCount).toBe(1)
    expect((await folderOf(w, id, 'INBOX')).unreadCount).toBe(1)
    expect((await folderOf(w, id, 'Archive')).totalCount).toBe(1)
    expect((await folderOf(w, id, 'Archive')).unreadCount).toBe(1)

    await w.engine.getMessage(w.token, id, 'INBOX', 2, { markSeen: true })
    await w.engine.deleteMessage(w.token, id, 'INBOX', 2) // moved to Trash
    expect((await folderOf(w, id, 'INBOX')).totalCount).toBe(0)
    expect((await folderOf(w, id, 'INBOX')).unreadCount).toBe(0)
    expect((await folderOf(w, id, 'Trash')).totalCount).toBe(1)
  })

  it('counters stay consistent with a fresh sync after mutations', async () => {
    await w.engine.getMessage(w.token, id, 'INBOX', 1, { markSeen: true })
    // Next sync overwrites counters with server truth — must match the deltas.
    await w.engine.syncFolder(w.web, id, 'INBOX')
    expect((await folderOf(w, id)).unreadCount).toBe(1)
    expect((await folderOf(w, id)).totalCount).toBe(2)
  })

  it('never wipes the cached folders when the server returns an empty LIST', async () => {
    // A flaky server that answers LIST with nothing (transient glitch).
    const t = w.transports.get('imap.test')!
    const realList = t.listFolders.bind(t)
    t.listFolders = async () => []
    await w.engine.refreshFolderList(id)
    t.listFolders = realList
    // Cache intact: folders and their messages are still there.
    const folders = await w.engine.listFolders(w.web, id)
    expect(folders.map((f) => f.path)).toEqual(['INBOX', 'Sent', 'Trash'])
    const list = await w.engine.listMessages(w.token, id, { folder: 'INBOX', sync: false })
    expect(list.total).toBe(2)
  })

  it('folder STATUS counts are cached at add time and on folder-list refresh', async () => {
    // A transport that already holds 2 unread messages when the account is added.
    const fresh = makeWorld()
    const t = new InMemoryTransport('me@example.com')
    fresh.transports.set('imap.test', t)
    t.deliver('INBOX', makeRaw({ subject: 'One' }))
    t.deliver('INBOX', makeRaw({ subject: 'Two' }))
    const freshId = await addAccount(fresh)
    const added = await folderOf(fresh, freshId)
    expect(added.totalCount).toBe(2)
    expect(added.unreadCount).toBe(2)
    // refreshFolderList re-STATUSes and overwrites the cache with server truth.
    t.deliver('INBOX', makeRaw({ subject: 'Three' }))
    await fresh.engine.refreshFolderList(freshId)
    const refreshed = await folderOf(fresh, freshId)
    expect(refreshed.totalCount).toBe(3)
    expect(refreshed.unreadCount).toBe(3)
  })
})

describe('reply addressing', () => {
  let w: World
  let id: string
  let transport: InMemoryTransport

  beforeEach(async () => {
    w = makeWorld()
    id = await addAccount(w)
    transport = w.transports.get('imap.test')!
  })

  it('uses Reply-To when present, keeping In-Reply-To and References', async () => {
    transport.deliver('INBOX', makeRaw({
      from: 'Carol <carol@example.com>',
      subject: 'Help',
      text: 'I need help.',
      extraHeaders: {
        'Reply-To': 'Carol Support <support@example.com>',
        'References': '<root@x.test> <parent@x.test>',
      },
    }))
    await w.engine.syncFolder(w.web, id, 'INBOX')
    const detail = await w.engine.getMessage(w.token, id, 'INBOX', 1, { markSeen: true })

    // Reply-To surfaced in the detail payload for the frontend.
    expect(detail.replyTo.map((a) => a.email)).toEqual(['support@example.com'])
    expect(detail.references).toEqual(['root@x.test', 'parent@x.test'])

    await w.engine.sendMessage(w.token, {
      accountId: id,
      to: detail.replyTo,
      subject: 'Re: Help',
      text: 'Sure, here you go.',
      inReplyTo: detail.messageId ?? undefined,
      references: [...detail.references, detail.messageId!],
    })
    const headers = sentHeaders(w.smtp.sent[0]!.raw)
    expect(headers['to']).toBe('Carol Support <support@example.com>')
    expect(headers['in-reply-to']).toBe(`<${detail.messageId}>`)
    // References chain: original thread + our own message id, all wrapped in <>.
    const refs = headers['references']!.split(/\s+/)
    expect(refs).toEqual(['<root@x.test>', '<parent@x.test>', `<${detail.messageId}>`])
    expect(headers['from']).toContain('me@example.com')
  })

  it('falls back to From when Reply-To is absent', async () => {
    transport.deliver('INBOX', makeRaw({ from: 'Dave <dave@example.com>', subject: 'No reply-to', text: 'hello' }))
    await w.engine.syncFolder(w.web, id, 'INBOX')
    const detail = await w.engine.getMessage(w.token, id, 'INBOX', 1, { markSeen: false })
    expect(detail.replyTo).toEqual([])
    await w.engine.sendMessage(w.token, {
      accountId: id,
      to: detail.from,
      subject: 'Re: No reply-to',
      text: 'ok',
    })
    const headers = sentHeaders(w.smtp.sent[0]!.raw)
    expect(headers['to']).toBe('Dave <dave@example.com>')
    expect(headers['references']).toBeUndefined()
  })

  it('handles MIME display names and keeps the answered conversation coherent', async () => {
    transport.deliver('INBOX', makeRaw({
      from: 'Ünïcode Namé <unicode@example.com>',
      subject: 'Ping',
      text: 'body with é è à',
      extraHeaders: { 'Reply-To': 'Ünïcode Namé <unicode@example.com>' },
    }))
    await w.engine.syncFolder(w.web, id, 'INBOX')
    const detail = await w.engine.getMessage(w.token, id, 'INBOX', 1, { markSeen: true })
    expect(detail.from[0]!.name).toBe('Ünïcode Namé')
    expect(detail.bodyText).toContain('é è à')

    await w.engine.sendMessage(w.token, {
      accountId: id,
      to: detail.replyTo,
      subject: 'Re: Ping',
      text: 'réponse en français',
      inReplyTo: detail.messageId ?? undefined,
    })
    const headers = sentHeaders(w.smtp.sent[0]!.raw)
    // Encoded-word display name round-trips through the composer.
    expect(headers['to']).toContain('unicode@example.com')
  })
})

describe('readability of text-only HTML parts (wall-of-text fix)', () => {
  it('keeps the author newlines when the HTML part has no formatting markup', () => {
    const raw = 'Ligne 1\nLigne 2 avec https://aide.lws.fr/a/1069\nLigne 3'
    const clean = sanitizeEmailHtml(raw)
    expect(clean).toContain('<br>')
    expect(clean).toContain('Ligne 1')
    expect(clean).toContain('Ligne 3')
    // Every newline is the cosmetic one after a <br> — no bare newline is
    // left inside a text run (a browser would collapse it into a space).
    expect(clean.replace(/<br>\n/g, '')).not.toContain('\n')
  })

  it('leaves properly structured HTML untouched', () => {
    const raw = '<p>Para one</p>\n<p>Para two</p>'
    expect(sanitizeEmailHtml(raw)).toBe(raw)
  })

  it('syncing a stored message exposes readable line breaks in the body', async () => {
    const fresh = makeWorld()
    const t = new InMemoryTransport('me@example.com')
    fresh.transports.set('imap.test', t)
    // Newsletter-style part: text/html whose only formatting is raw newlines.
    const id = await addAccount(fresh)
    t.deliver('INBOX', makeRaw({
      subject: 'LWS welcome',
      html: 'Paris le : 27-10-2026\nObjet : Ouverture du compte\n\nMadame, Monsieur,\nBienvenue.',
      text: 'Paris le : 27-10-2026\nObjet : Ouverture du compte\n\nMadame, Monsieur,\nBienvenue.',
    }))
    await fresh.engine.syncFolder(fresh.web, id, 'INBOX')
    const detail = await fresh.engine.getMessage(fresh.token, id, 'INBOX', 1, { markSeen: false })
    expect(detail.bodyHtml).toContain('<br>')
    expect(detail.bodyHtml).toContain('Madame, Monsieur,')
  })
})

describe('folder counters stay equal to the unread dots (recount fix)', () => {
  let w: World
  let id: string

  beforeEach(async () => {
    w = makeWorld()
    id = await addAccount(w)
    const t = w.transports.get('imap.test')!
    t.deliver('INBOX', makeRaw({ subject: 'One' }))
    t.deliver('INBOX', makeRaw({ subject: 'Two' }))
    await w.engine.syncFolder(w.web, id, 'INBOX')
  })

  const unreadInDb = () => (w.db.prepare('SELECT unread_count AS u FROM folders WHERE path = ?').get('INBOX') as { u: number }).u

  it('a drifted counter self-heals on the next flag mutation', async () => {
    // Simulate historical drift (older server version bumped nothing).
    w.db.prepare('UPDATE folders SET unread_count = 1 WHERE path = ?').run('INBOX')
    expect(unreadInDb()).toBe(1)
    // Reading one of the two unread messages recounts from the rows.
    await w.engine.getMessage(w.token, id, 'INBOX', 1, { markSeen: true })
    expect(unreadInDb()).toBe(1) // 2 rows, 1 now read, 1 unread — recount, not delta
  })

  it('a sync derives the counters from the reconciled rows, not STATUS alone', async () => {
    // Corrupt the cached counter, then let a sync reconcile flags.
    w.db.prepare('UPDATE folders SET unread_count = 7 WHERE path = ?').run('INBOX')
    await w.engine.syncFolder(w.web, id, 'INBOX')
    expect(unreadInDb()).toBe(2)
  })

  it('marking unread from the list keeps badge and dots equal', async () => {
    await w.engine.getMessage(w.token, id, 'INBOX', 1, { markSeen: true })
    await w.engine.getMessage(w.token, id, 'INBOX', 2, { markSeen: true })
    expect(unreadInDb()).toBe(0)
    await w.engine.patchMessage(w.token, id, 'INBOX', 2, { seen: false })
    expect(unreadInDb()).toBe(1)
    const list = await w.engine.listMessages(w.token, id, { folder: 'INBOX', sync: false })
    expect(list.messages.filter((m) => !m.seen)).toHaveLength(1)
  })
})

describe('refresh settings and concurrent sync dedup', () => {
  let w: World
  let id: string

  beforeEach(async () => {
    w = makeWorld()
    id = await addAccount(w)
  })

  it('defaults to 60s, persists chosen values and rejects unsupported ones', async () => {
    expect(w.engine.getRefreshIntervalMs(w.web)).toBe(DEFAULT_REFRESH_INTERVAL_MS)
    for (const ms of [0, 30_000, 120_000, 600_000]) {
      expect(w.engine.setRefreshIntervalMs(w.web, ms)).toBe(ms)
      expect(w.engine.getRefreshIntervalMs(w.web)).toBe(ms)
    }
    expect(() => w.engine.setRefreshIntervalMs(w.web, 45_000)).toThrow(badRequest('x').constructor)
    // Manual (0) and every documented choice are accepted.
    expect(REFRESH_INTERVALS_MS).toContain(300_000)
  })

  it('settings are per-user and isolated', async () => {
    w.engine.setRefreshIntervalMs(w.web, 30_000)
    w.auth.createUserGuarded({ email: 'other@x.test', password: 'password123' }, w.web)
    const otherSession = w.auth.contextForSession(w.auth.login('other@x.test', 'password123').token)!
    expect(w.engine.getRefreshIntervalMs(otherSession)).toBe(60_000)
    expect(w.engine.getRefreshIntervalMs(w.web)).toBe(30_000)
  })

  it('never runs two concurrent syncs of the same folder', async () => {
    const transport = w.transports.get('imap.test')!
    transport.deliver('INBOX', makeRaw({ subject: 'X' }))
    let calls = 0
    const original = transport.syncFolder.bind(transport)
    transport.syncFolder = async (...args) => {
      calls += 1
      await new Promise((r) => setTimeout(r, 80))
      return original(...args)
    }
    const [a, b] = await Promise.all([
      w.engine.syncFolder(w.web, id, 'INBOX'),
      w.engine.syncFolder(w.web, id, 'INBOX'),
    ])
    expect(calls).toBe(1)
    expect(a).toEqual(b)
    // After completion the mutex is released and a new sync runs again.
    await w.engine.syncFolder(w.web, id, 'INBOX')
    expect(calls).toBe(2)
  })
})

describe('account editing', () => {
  let w: World
  let id: string

  beforeEach(async () => {
    w = makeWorld()
    id = await addAccount(w)
  })

  it('edits name/email without re-typing the password and keeps it working', async () => {
    const updated = await w.engine.updateAccount(w.web, id, { name: 'Renamed', email: 'renamed@example.com' })
    expect(updated.name).toBe('Renamed')
    expect(updated.email).toBe('renamed@example.com')

    // The stored IMAP secret is unchanged and still decrypts to the original.
    const row = w.db.prepare('SELECT imap_pass_enc, smtp_pass_enc FROM mail_accounts WHERE id = ?').get(id) as { imap_pass_enc: string; smtp_pass_enc: string }
    expect(decryptSecret(row.imap_pass_enc, masterSecret)).toBe('secret')
    expect(decryptSecret(row.smtp_pass_enc, masterSecret)).toBe('secret')

    // And the engine can still build a working transport for it.
    await w.engine.syncFolder(w.web, id, 'INBOX')
  })

  it('updates SMTP credentials while keeping the IMAP ones', async () => {
    await w.engine.updateAccount(w.web, id, { smtp: { host: 'smtp2.test', port: 465, tls: 'tls', user: 'smtpuser', password: 'newsmtp' } })
    const row = w.db.prepare('SELECT imap_pass_enc, smtp_pass_enc, smtp_host FROM mail_accounts WHERE id = ?').get(id) as { imap_pass_enc: string; smtp_pass_enc: string; smtp_host: string }
    expect(row.smtp_host).toBe('smtp2.test')
    expect(decryptSecret(row.imap_pass_enc, masterSecret)).toBe('secret')
    expect(decryptSecret(row.smtp_pass_enc, masterSecret)).toBe('newsmtp')
  })

  it('probes the connection when IMAP credentials change, and returns no secrets', async () => {
    const before = w.factoryCalls
    // Name-only change must NOT open a probe connection.
    await w.engine.updateAccount(w.web, id, { name: 'No probe' })
    expect(w.factoryCalls).toBe(before)

    // Credential change opens exactly one probe connection.
    await w.engine.updateAccount(w.web, id, { imap: { user: 'newuser@example.com', password: 'newpass' } })
    expect(w.factoryCalls).toBe(before + 1)

    const info = w.engine.listAccounts(w.web)[0]!
    const json = JSON.stringify(info)
    expect(json).not.toContain('newpass')
    expect(json).not.toContain('secret')
  })
})

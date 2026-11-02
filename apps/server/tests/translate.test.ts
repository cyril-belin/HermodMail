import { beforeEach, describe, expect, it } from 'vitest'
import { openInMemoryDatabase, type DB } from '../src/db/database.js'
import { AuthService } from '../src/core/auth-service.js'
import { MailStore } from '../src/core/mail/store.js'
import { MailEngine } from '../src/core/mail/engine.js'
import { AiProviderRegistry } from '../src/core/ai/provider.js'
import { AiService, parseTranslationReply } from '../src/core/ai/service.js'
import { InMemoryTransport, FakeSmtpSender, makeRaw } from './inmemory-transport.js'
import type { Config } from '../src/config.js'
import type { ChatMessage, AiProvider } from '../src/core/ai/provider.js'
import type { AuthContext } from '../src/core/types.js'
import { SCOPES } from '../src/core/types.js'
import { AppError } from '../src/core/errors.js'

const masterSecret = Buffer.from('a'.repeat(32))

class StubProvider implements AiProvider {
  readonly name = 'stub'
  readonly model = 'stub-1'
  lastMessages: ChatMessage[] = []
  calls = 0
  reply = 'LANG: en\nHello translated body'
  async chat(messages: ChatMessage[]): Promise<string> {
    this.lastMessages = messages
    this.calls++
    return this.reply
  }
}

describe('AiService.translate', () => {
  let db: DB
  let engine: MailEngine
  let registry: AiProviderRegistry
  let ai: AiService
  let stub: StubProvider
  let ctx: AuthContext
  let accountId: string
  let htmlMessageUid: number

  beforeEach(async () => {
    db = openInMemoryDatabase()
    const auth = new AuthService(db, 24)
    const store = new MailStore(db)
    stub = new StubProvider()
    const transports = new Map<string, InMemoryTransport>()
    engine = new MailEngine(
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
    registry = new AiProviderRegistry(db, masterSecret)
    registry.getActiveProvider = () => stub
    ai = new AiService(registry, store, engine)

    auth.createUserGuarded({ email: 'u@x.test', password: 'password123' })
    const web = auth.contextForSession(auth.login('u@x.test', 'password123').token)!
    ctx = { userId: web.userId, isAdmin: web.isAdmin, kind: 'web', scopes: new Set(Object.values(SCOPES)) }

    const info = await engine.addAccount(ctx, {
      name: 'T', email: 'me@example.com',
      imap: { host: 'imap.tr', port: 993, tls: 'tls', user: 'me@example.com', password: 'p' },
      smtp: { host: 'smtp.tr', port: 587, tls: 'starttls' },
    })
    accountId = info.id
    const transport = transports.get('imap.tr')!
    transport.deliver('INBOX', makeRaw({
      subject: 'Facture',
      from: 'Client <client@vendor.test>',
      text: 'Bonjour, voici la facture du mois. Merci de valider le paiement avant vendredi.',
    }))
    transport.deliver('INBOX', makeRaw({
      subject: 'Newsletter',
      from: 'News <news@vendor.test>',
      text: 'Plain version',
      html: '<html><body><h1>Titre</h1><p>Bonjour, voici la <strong>facture</strong> du mois.</p></body></html>',
    }))
    await engine.syncFolder(ctx, accountId, 'INBOX')
    htmlMessageUid = 2
  })

  it('translates plain text and reports the detected source language', async () => {
    const tr = await ai.translate(ctx, accountId, 'INBOX', 1, 'es')
    expect(tr.target).toBe('es')
    expect(tr.from).toBe('en')
    expect(tr.text).toBe('Hello translated body')
    expect(tr.html).toBeUndefined()
  })

  it('translates HTML preserving structure and re-sanitizes the output', async () => {
    stub.reply = 'LANG: fr\n<html><body><h1>Traduit</h1><p>Bonjour <img src=x onerror=alert(1)> du corps.</p></body></html>'
    const tr = await ai.translate(ctx, accountId, 'INBOX', htmlMessageUid, 'en')
    expect(tr.html).toBeDefined()
    expect(tr.html).toContain('<h1>')
    expect(tr.html).toContain('Traduit')
    // The model output is untrusted: event handlers must not survive sanitization.
    expect(tr.html).not.toContain('onerror')
    expect(tr.text).toBeUndefined()
  })

  it('caches the translation — the provider is not called twice for the same target', async () => {
    await ai.translate(ctx, accountId, 'INBOX', 1, 'es')
    expect(stub.calls).toBe(1)
    const again = await ai.translate(ctx, accountId, 'INBOX', 1, 'es')
    expect(stub.calls).toBe(1)
    expect(again.text).toBe('Hello translated body')
    // A different target is a new translation.
    await ai.translate(ctx, accountId, 'INBOX', 1, 'en')
    expect(stub.calls).toBe(2)
  })

  it('translation survives a re-read through the engine (extras)', async () => {
    await ai.translate(ctx, accountId, 'INBOX', 1, 'fr')
    const detail = await engine.getMessage(ctx, accountId, 'INBOX', 1, { markSeen: false })
    expect(detail.translation?.target).toBe('fr')
    expect(detail.translation?.text).toBe('Hello translated body')
  })

  it('never marks the message as seen and never touches the transport flags', async () => {
    await ai.translate(ctx, accountId, 'INBOX', 1, 'fr')
    const detail = await engine.getMessage(ctx, accountId, 'INBOX', 1, { markSeen: false })
    expect(detail.seen).toBe(false)
  })

  it('rejects unsupported target languages', async () => {
    // @ts-expect-error — deliberate invalid target
    await expect(ai.translate(ctx, accountId, 'INBOX', 1, 'de')).rejects.toThrowError(AppError)
  })

  it('requires the ai:use scope', async () => {
    const auth = new AuthService(db, 24)
    const { token: raw } = auth.createToken(ctx.userId, 'limited', [SCOPES.mailRead])
    const limited = auth.contextForToken(raw)!
    await expect(ai.translate(limited, accountId, 'INBOX', 1, 'fr')).rejects.toThrowError(AppError)
  })

  it('sends the content fenced and asks for a LANG line', async () => {
    await ai.translate(ctx, accountId, 'INBOX', 1, 'fr')
    const userMsg = stub.lastMessages.find((m) => m.role === 'user')!
    expect(userMsg.content).toContain('<<<UNTRUSTED_EMAIL_CONTENT')
    expect(userMsg.content).toContain('LANG:')
    expect(userMsg.content).toContain('facture')
    const sys = stub.lastMessages.find((m) => m.role === 'system')!
    expect(sys.content).toContain('SECURITY RULES')
  })
})

describe('parseTranslationReply', () => {
  it('splits the LANG header from the body', () => {
    expect(parseTranslationReply('LANG: es\nHola mundo')).toEqual({ from: 'es', content: 'Hola mundo' })
    expect(parseTranslationReply('lang: FR\nSalut')).toEqual({ from: 'fr', content: 'Salut' })
    expect(parseTranslationReply('LANG: unknown\nText')).toEqual({ from: 'unknown', content: 'Text' })
  })

  it('treats a missing header as unknown language with the full reply as content', () => {
    expect(parseTranslationReply('Just the translation')).toEqual({ from: 'unknown', content: 'Just the translation' })
    expect(parseTranslationReply('LANG: spanish\nx')).toEqual({ from: 'unknown', content: 'LANG: spanish\nx' })
  })
})

// ----- user locale preference -------------------------------------------------

describe('engine user locale settings', () => {
  let db: DB
  let engine: MailEngine
  let ctx: AuthContext

  beforeEach(async () => {
    db = openInMemoryDatabase()
    const auth = new AuthService(db, 24)
    const store = new MailStore(db)
    engine = new MailEngine(
      db,
      { port: 0, host: '', dataDir: '', masterSecret, webDist: undefined, trustProxy: false, sessionTtlHours: 1, initialSyncLimit: 20, bodyIndexLimit: 20, maxAttachmentSize: 100_000 } satisfies Config,
      store,
      async () => { throw new Error('no transport in this test') },
      new FakeSmtpSender().sender,
      () => {},
    )
    auth.createUserGuarded({ email: 'u@x.test', password: 'password123' })
    const web = auth.contextForSession(auth.login('u@x.test', 'password123').token)!
    ctx = { userId: web.userId, isAdmin: web.isAdmin, kind: 'web', scopes: new Set(Object.values(SCOPES)) }
  })

  it('migration v4 added the locale and translation columns', () => {
    expect(db.pragma('user_version', { simple: true })).toBe(4)
    const cols = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)
    expect(cols('user_settings')).toContain('locale')
    expect(cols('message_extras')).toContain('translation_json')
  })

  it('defaults to empty (client-side detection) and persists the choice', () => {
    expect(engine.getUserLocale(ctx)).toBe('')
    engine.setUserLocale(ctx, 'es')
    expect(engine.getUserLocale(ctx)).toBe('es')
    engine.setUserLocale(ctx, 'fr')
    expect(engine.getUserLocale(ctx)).toBe('fr')
  })

  it('rejects unsupported locales', () => {
    expect(() => engine.setUserLocale(ctx, 'de')).toThrowError(AppError)
    expect(() => engine.setUserLocale(ctx, "fr'; DROP TABLE users")).toThrowError(AppError)
  })

  it('keeps locales isolated per user', () => {
    engine.setUserLocale(ctx, 'en')
    const auth = new AuthService(db, 24)
    // The first user became admin: creating a second one requires an admin actor.
    auth.createUserGuarded({ email: 'v@x.test', password: 'password123' }, ctx)
    const other = auth.contextForSession(auth.login('v@x.test', 'password123').token)!
    expect(engine.getUserLocale({ userId: other.userId, isAdmin: other.isAdmin, kind: 'web', scopes: new Set(Object.values(SCOPES)) })).toBe('')
  })
})

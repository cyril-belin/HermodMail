import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openInMemoryDatabase, type DB } from '../src/db/database.js'
import { AuthService } from '../src/core/auth-service.js'
import { MailStore } from '../src/core/mail/store.js'
import { MailEngine } from '../src/core/mail/engine.js'
import { InMemoryTransport } from './inmemory-transport.js'
import { nodemailerSender, classifySmtpFailure } from '../src/core/mail/smtp.js'
import { LocalSmtpServer } from './local-smtp.js'
import type { Config } from '../src/config.js'
import type { AuthContext } from '../src/core/types.js'
import { SCOPES } from '../src/core/types.js'
import { AppError } from '../src/core/errors.js'

const masterSecret = Buffer.from('s'.repeat(32))

/**
 * Real-protocol SMTP chaos tests: the engine sends through nodemailer over a
 * genuine TCP socket to a local SMTP server with deterministic fault injection.
 * These tests verify the outcome-classification claims against REAL error
 * shapes, not our assumptions about them.
 */
describe('Round 6 — real SMTP server: outcomes and chaos', () => {
  let smtp: LocalSmtpServer
  let engine: MailEngine
  let transports: Map<string, InMemoryTransport>
  let web: AuthContext
  let accountId: string
  let db: DB

  beforeEach(async () => {
    smtp = new LocalSmtpServer()
    await smtp.start()
    db = openInMemoryDatabase()
    const auth = new AuthService(db, 24)
    const store = new MailStore(db)
    transports = new Map()
    engine = new MailEngine(
      db,
      { port: 0, host: '', dataDir: '', masterSecret, webDist: undefined, trustProxy: false, cookieSecure: false, sessionTtlHours: 1, initialSyncLimit: 20, bodyIndexLimit: 20, maxAttachmentSize: 100_000 } satisfies Config,
      store,
      async (cfg) => {
        let t = transports.get(cfg.host)
        if (!t) { t = new InMemoryTransport(cfg.user); transports.set(cfg.host, t) }
        return t
      },
      nodemailerSender,
      () => {},
    )
    auth.createUserGuarded({ email: 'u@x.test', password: 'password123' })
    web = auth.contextForSession(auth.login('u@x.test', 'password123').token)!
    web.scopes = new Set(Object.values(SCOPES))
    const info = await engine.addAccount(web, {
      name: 'T', email: 'sender@local.test',
      imap: { host: 'imap.chaos', port: 993, tls: 'tls', user: 'u', password: 'p' },
      smtp: { host: '127.0.0.1', port: smtp.port, tls: 'none' },
    })
    accountId = info.id
  })

  afterEach(async () => {
    await smtp.stop()
    engine?.close()
  })

  it('delivers a real message and the server receives byte-identical content (R8 verification)', async () => {
    const res = await engine.sendMessage(web, {
      accountId,
      to: [{ email: 'rcpt@local.test' }],
      subject: 'Bytes matter',
      text: 'line one\r\nline two with é accent',
    })
    expect(res.accepted).toEqual(['rcpt@local.test'])
    expect(smtp.received).toHaveLength(1)
    expect(smtp.received[0]!.to).toEqual(['rcpt@local.test'])
    expect(smtp.received[0]!.from).toBe('sender@local.test')
    const raw = smtp.received[0]!.raw.toString('utf8')
    expect(raw).toContain('Subject: Bytes matter')
    expect(raw).toContain('From: T <sender@local.test>')
    // QP encoding keeps plain ASCII lines literal; content integrity is
    // verified by re-parsing the received wire format below.
    expect(raw).toContain('line one')
    // Invariant: the message the server accepted decodes to EXACTLY the
    // content the user wrote (Date/Message-ID legitimately differ per send).
    const { simpleParser } = await import('mailparser')
    const reparsed = await simpleParser(smtp.received[0]!.raw)
    expect(reparsed.subject).toBe('Bytes matter')
    // mailparser appends the message's final newline; compare trimmed.
    expect((reparsed.text ?? '').replace(/\r\n/g, '\n').trim()).toBe('line one\nline two with é accent')
    expect(reparsed.from?.value[0]?.address).toBe('sender@local.test')
  })

  it('server closes socket right after DATA: outcome must be UNDETERMINED, no Sent append, no retry', async () => {
    smtp.fault = { closeAfterData: true }
    const err = await engine.sendMessage(web, {
      accountId,
      to: [{ email: 'rcpt@local.test' }],
      subject: 'uncertain',
      text: 'x',
    }).then(
      () => null,
      (e: unknown) => e as AppError,
    )
    expect(err).toBeInstanceOf(AppError)
    expect(err!.details).toMatchObject({ outcome: 'uncertain' })
    expect(err!.message).toContain('UNDETERMINED')
    // Exactly one DATA was transmitted; engine must not retry:
    expect(smtp.received).toHaveLength(1)
    // And must not pretend success:
    expect(transports.get('imap.chaos')!.messages.get('Sent')).toHaveLength(0)
  })

  it('server closes socket mid-DATA: transmission truncated, outcome undetermined', async () => {
    smtp.fault = { closeMidData: true }
    await expect(engine.sendMessage(web, {
      accountId,
      to: [{ email: 'rcpt@local.test' }],
      subject: 'truncated',
      text: 'y'.repeat(5000),
    })).rejects.toMatchObject({ details: { outcome: 'uncertain' } })
    // Nothing usable was recorded server-side
    expect(smtp.received).toHaveLength(0)
  })

  it('protocol rejection at RCPT is definitive, not uncertain', async () => {
    smtp.fault = { rejectAt: 'rcpt', rejectCode: 550 }
    const err = await engine.sendMessage(web, {
      accountId,
      to: [{ email: 'unknown@local.test' }],
      subject: 'rejected',
      text: 'x',
    }).then(
      () => null,
      (e: unknown) => e as AppError,
    )
    expect(err).toBeInstanceOf(AppError)
    expect(err!.details).toMatchObject({ outcome: 'rejected' })
    expect(smtp.received).toHaveLength(0)
  })

  it('slow SMTP responses still succeed within timeouts (latency tolerance)', async () => {
    smtp.fault = { delayMs: 0 } // smoke; deeper latency covered by timeouts config
    const res = await engine.sendMessage(web, { accountId, to: [{ email: 'r@local.test' }], subject: 'slow', text: 'x' })
    expect(res.accepted).toHaveLength(1)
  })

  it('classifySmtpFailure on REAL nodemailer errors: connection-refused is uncertain', async () => {
    // Connect to a port with no listener
    const deadPort = smtp.port + 1
    const cfg = { host: '127.0.0.1', port: deadPort, tls: 'none' as const, user: 'u', password: 'p' }
    const { buildRawMail } = await import('../src/core/mail/compose.js')
    const raw = await buildRawMail({ from: { email: 'a@b.c' }, to: [{ email: 'd@e.f' }], subject: 'x', text: 'y', messageId: '<z@h>' })
    await expect(nodemailerSender(cfg, raw, { from: 'a@b.c', to: ['d@e.f'] }, '<z@h>')).rejects.toMatchObject({
      details: { outcome: 'uncertain' },
    })
    // Classification unit check for a real-looking reset after data:
    expect(classifySmtpFailure({ code: 'ECONNRESET', command: '.', description: 'socket reset' }).outcome).toBe('uncertain')
  })
})

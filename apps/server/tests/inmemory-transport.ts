import type {
  EnvelopeData,
  MailTransport,
  SmtpSendResult,
  SmtpSender,
  SyncResult,
  TransportConfig,
} from '../src/core/mail/transport.js'
import { AppError } from '../src/core/errors.js'

/** A single message living in the fake mailbox. */
export interface FakeMessage {
  folder: string
  uid: number
  flags: Set<string>
  raw: Buffer
}

/** Minimal but real RFC822 message used to exercise mailparser. */
export function makeRaw(opts: {
  from?: string
  to?: string
  subject?: string
  text?: string
  html?: string
  attachment?: { filename: string; content: string; contentType?: string }
  extraHeaders?: Record<string, string>
}): Buffer {
  const lines: string[] = [
    `From: ${opts.from ?? 'Alice <alice@example.com>'}`,
    `To: ${opts.to ?? 'bob@example.com'}`,
    `Subject: ${opts.subject ?? 'Hello'}`,
    `Date: ${new Date('2026-01-15T10:00:00Z').toUTCString()}`,
    `Message-ID: <fake-${Math.random().toString(36).slice(2)}@example.com>`,
    `MIME-Version: 1.0`,
    ...Object.entries(opts.extraHeaders ?? {}).map(([k, v]) => `${k}: ${v}`),
  ]
  if (opts.attachment) {
    const boundary = '----=_hermod_attach'
    lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`, '', 'multipart message')
    lines.push(`--${boundary}`, 'Content-Type: text/plain; charset=utf-8', '', opts.text ?? '', '')
    const b64 = Buffer.from(opts.attachment.content, 'utf8').toString('base64')
    lines.push(
      `--${boundary}`,
      `Content-Type: ${opts.attachment.contentType ?? 'application/octet-stream'}; name="${opts.attachment.filename}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${opts.attachment.filename}"`,
      '',
      b64,
      `--${boundary}--`,
      '',
    )
    return Buffer.from(lines.join('\r\n'))
  }
  if (opts.html) {
    const boundary = '----=_hermod_test'
    lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`, '', 'This is a multi-part message in MIME format.')
    lines.push(`--${boundary}`, 'Content-Type: text/plain; charset=utf-8', '', opts.text ?? 'plain fallback', '')
    lines.push(`--${boundary}`, 'Content-Type: text/html; charset=utf-8', '', opts.html, `--${boundary}--`, '')
  } else {
    lines.push('Content-Type: text/plain; charset=utf-8', '', opts.text ?? '', '')
  }
  return Buffer.from(lines.join('\r\n'))
}

export function makeEnvelope(uid: number, over: Partial<EnvelopeData> = {}): EnvelopeData {
  return {
    uid,
    messageId: `msg-${uid}@example.com`,
    subject: `Subject ${uid}`,
    from: [{ name: 'Alice', email: 'alice@example.com' }],
    to: [{ email: 'bob@example.com' }],
    cc: [],
    date: Date.parse('2026-01-15T10:00:00Z') + uid * 1000,
    size: 500 + uid,
    seen: false,
    flagged: false,
    answered: false,
    draft: false,
    deleted: false,
    hasAttachments: false,
    inReplyTo: null,
    replyTo: [],
    ...over,
  }
}

/**
 * In-memory MailTransport: deterministic, no network. Models a single mailbox
 * with folders holding FakeMessages.
 */
export class InMemoryTransport implements MailTransport {
  readonly messages = new Map<string, FakeMessage[]>() // folder -> messages
  readonly folders = new Map<string, { delimiter: string; specialUse: string | null }>()
  private uidCounters = new Map<string, number>()
  /** Server-reported UIDVALIDITY; tests can simulate a mailbox rebuild. */
  uidValidity = 42
  /** When set, the next operation throws (connection-failure simulation). */
  failNext: string | null = null
  /** When true, failNext is NOT consumed after one throw (persistent outage). */
  failSticky = false
  /** When true, noop() rejects — simulates a pooled connection that died. */
  noopFails = false

  constructor(readonly accountEmail: string) {
    this.addFolder('INBOX', null)
    this.addFolder('Sent', 'sent')
    this.addFolder('Trash', 'trash')
  }

  /** Set by close() — lets tests assert pooled connections are actually closed. */
  closed = false

  async close(): Promise<void> {
    this.closed = true
  }

  async noop(): Promise<void> {
    if (this.noopFails) throw new Error('connection dead')
  }

  /** Simulate the mailbox being wiped and rebuilt (new UIDVALIDITY). */
  rebuildMailbox(): void {
    this.uidValidity += 1
  }

  addFolder(path: string, specialUse: string | null): void {
    this.folders.set(path, { delimiter: '/', specialUse })
    if (!this.messages.has(path)) this.messages.set(path, [])
    if (!this.uidCounters.has(path)) this.uidCounters.set(path, 0)
  }

  /** Inject a message directly into a folder, returns its uid. */
  deliver(folder: string, raw: Buffer, flags: string[] = [], uid?: number): number {
    const list = this.messages.get(folder)
    if (!list) throw new Error(`no such folder ${folder}`)
    const next = (this.uidCounters.get(folder) ?? 0) + 1
    const actualUid = uid ?? next
    this.uidCounters.set(folder, Math.max(this.uidCounters.get(folder) ?? 0, actualUid))
    list.push({ folder, uid: actualUid, flags: new Set(flags), raw })
    return actualUid
  }

  private checkFail(what: string): void {
    if (this.failNext === what || this.failNext === '*') {
      if (!this.failSticky) this.failNext = null
      // Deterministic dead-connection simulation, same contract as imapflow adapter.
      throw new AppError('mail_connection', `simulated dead connection during ${what}`)
    }
  }

  async listFolders() {
    this.checkFail('listFolders')
    return [...this.folders.entries()].map(([path, f]) => ({
      path,
      delimiter: f.delimiter,
      specialUse: f.specialUse,
      totalCount: this.messages.get(path)!.length,
      unreadCount: this.messages.get(path)!.filter((m) => !m.flags.has('\\Seen')).length,
    }))
  }

  async syncFolder(path: string, knownUidvalidity: number | null, sinceUid: number, limit: number): Promise<SyncResult> {
    this.checkFail('syncFolder')
    const list = this.messages.get(path)
    if (!list) throw new Error('no such folder')
    const all = list.map((m) => toEnvelope(m))
    // On uidvalidity change (mailbox rebuild) return the newest window regardless
    // of sinceUid — mirroring the real-IMAP contract in transport.ts.
    const fullResync = knownUidvalidity !== null && knownUidvalidity !== this.uidValidity
    const newMessages = fullResync
      ? all.slice(-limit).reverse()
      : all.filter((e) => e.uid > sinceUid).slice(-limit).reverse()
    const flags = new Map(all.filter((e) => e.uid <= sinceUid).map((e) => [e.uid, {
      seen: e.seen, flagged: e.flagged, answered: e.answered, deleted: e.deleted, draft: e.draft,
    }]))
    return {
      uidvalidity: this.uidValidity,
      newMessages,
      flags,
      totalCount: all.length,
      unreadCount: list.filter((m) => !m.flags.has('\\Seen')).length,
    }
  }

  async fetchMessageSource(path: string, uid: number): Promise<Buffer | null> {
    const m = this.messages.get(path)?.find((x) => x.uid === uid)
    return m ? Buffer.from(m.raw) : null
  }

  async listUids(path: string): Promise<number[]> {
    this.checkFail('listUids')
    return (this.messages.get(path) ?? []).map((m) => m.uid)
  }

  async updateFlags(path: string, uid: number, patch: { add?: string[]; remove?: string[] }): Promise<void> {
    const m = this.messages.get(path)?.find((x) => x.uid === uid)
    if (!m) throw new Error('no such message')
    for (const f of patch.add ?? []) m.flags.add(f)
    for (const f of patch.remove ?? []) m.flags.delete(f)
  }

  async moveMessage(path: string, uid: number, destPath: string): Promise<void> {
    const from = this.messages.get(path)
    const m = from?.find((x) => x.uid === uid)
    if (!m) throw new Error('no such message')
    from!.splice(from!.indexOf(m), 1)
    this.deliver(destPath, m.raw, [...m.flags])
  }

  async expungeMessage(path: string, uid: number): Promise<void> {
    const from = this.messages.get(path)
    const m = from?.find((x) => x.uid === uid)
    if (!m) throw new Error('no such message')
    from!.splice(from!.indexOf(m), 1)
  }

  async appendMessage(path: string, raw: Buffer, flags: string[]): Promise<number | null> {
    return this.deliver(path, raw, flags)
  }

  async createFolder(path: string): Promise<void> {
    this.addFolder(path, null)
  }

  async renameFolder(path: string, newPath: string): Promise<void> {
    const f = this.folders.get(path)
    if (!f) throw new Error('no such folder')
    this.folders.set(newPath, f)
    this.messages.set(newPath, this.messages.get(path)!)
    this.folders.delete(path)
    this.messages.delete(path)
  }

  async deleteFolder(path: string): Promise<void> {
    this.folders.delete(path)
    this.messages.delete(path)
  }
}

function toEnvelope(m: FakeMessage): EnvelopeData {
  const headers = parseHeaders(m.raw)
  return {
    uid: m.uid,
    messageId: (headers['message-id'] ?? '').replace(/[<>]/g, '') || null,
    subject: headers.subject ?? '',
    from: parseAddrHeader(headers.from),
    replyTo: parseAddrHeader(headers['reply-to']),
    to: parseAddrHeader(headers.to),
    cc: parseAddrHeader(headers.cc),
    date: headers.date ? Date.parse(headers.date) : null,
    size: m.raw.length,
    seen: m.flags.has('\\Seen'),
    flagged: m.flags.has('\\Flagged'),
    answered: m.flags.has('\\Answered'),
    deleted: m.flags.has('\\Deleted'),
    draft: m.flags.has('\\Draft'),
    hasAttachments: false,
    inReplyTo: headers['in-reply-to'] ? headers['in-reply-to'].replace(/[<>]/g, '') : null,
  }
}

function parseHeaders(raw: Buffer): Record<string, string> {
  const out: Record<string, string> = {}
  const headerBlock = raw.toString('utf8').split('\r\n\r\n')[0] ?? ''
  for (const line of headerBlock.split('\r\n')) {
    const idx = line.indexOf(':')
    if (idx > 0) out[line.slice(0, idx).toLowerCase()] = line.slice(idx + 1).trim()
  }
  return out
}

function parseAddrHeader(value: string | undefined): { name?: string; email: string }[] {
  if (!value) return []
  const match = value.match(/^(.*?)\s*<\s*([^\s@]+@[^\s@]+)\s*>$/)
  if (match) return [{ name: match[1]!.replace(/"/g, '').trim() || undefined, email: match[2]! }]
  return [{ email: value.trim() }]
}

/** Fake SMTP sender recording what was sent. */
export class FakeSmtpSender {
  readonly sent: { to: string[]; raw: Buffer; messageId: string }[] = []
  readonly sender: SmtpSender = async (_smtp: TransportConfig, raw: Buffer, envelope, messageId): Promise<SmtpSendResult> => {
    this.sent.push({ to: envelope.to, raw, messageId })
    return { messageId, accepted: [...envelope.to], rejected: [] }
  }
}

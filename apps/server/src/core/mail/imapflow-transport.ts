import { ImapFlow } from 'imapflow'
import { AppError } from '../errors.js'
import type { Address } from '../types.js'
import type {
  EnvelopeData,
  MailTransport,
  SyncResult,
  TransportConfig,
  TransportFolder,
} from './transport.js'

interface ImapFlowAddress {
  name?: string
  address?: string
  host?: string
}
interface ImapFlowEnvelope {
  subject?: string | null
  from?: ImapFlowAddress[] | false
  replyTo?: ImapFlowAddress[] | false
  to?: ImapFlowAddress[] | false
  cc?: ImapFlowAddress[] | false
  date?: Date | null
  messageId?: string | null
  inReplyTo?: string | null
}

function toAddresses(list: ImapFlowAddress[] | false | undefined): Address[] {
  if (!list || !Array.isArray(list)) return []
  return list
    .map((a) => ({ name: a.name || undefined, email: a.address || '' }))
    .filter((a) => a.email.length > 0)
}

function hasAttachmentNode(node: { disposition?: string; childNodes?: unknown[] }): boolean {
  if (node.disposition === 'attachment') return true
  const children = node.childNodes
  if (Array.isArray(children)) {
    for (const child of children) {
      if (child && typeof child === 'object' && hasAttachmentNode(child as { disposition?: string; childNodes?: unknown[] })) {
        return true
      }
    }
  }
  return false
}

function mapConnError(err: unknown, what: string): AppError {
  if (err instanceof AppError) return err
  const message = err instanceof Error ? err.message : String(err)
  const authFailure = /auth|login|credential/i.test(message)
  return new AppError(
    authFailure ? 'mail_connection' : 'mail_connection',
    `IMAP ${what} failed: ${message}`,
  )
}

/** Production MailTransport backed by a real IMAP server via imapflow. */
export class ImapFlowTransport implements MailTransport {
  private readonly client: ImapFlow

  private constructor(client: ImapFlow) {
    this.client = client
  }

  static async connect(cfg: TransportConfig): Promise<ImapFlowTransport> {
    const client = new ImapFlow({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.tls === 'tls',
      // 'starttls': imapflow upgrades opportunistically when the server supports it.
      auth: { user: cfg.user, pass: cfg.password },
      socketTimeout: 60_000,
      greetingTimeout: 20_000,
      emitLogs: false,
      logger: false,
    })
    try {
      await client.connect()
      // CRITICAL: without an 'error' listener, any async socket error on an
      // idle pooled connection (timeout, RST) emits an unhandled 'error'
      // event and KILLS the whole Node process. Connection-level errors are
      // surfaced on the next command instead (withReadTransport retries).
      client.on('error', () => {})
      return new ImapFlowTransport(client)
    } catch (err) {
      throw mapConnError(err, `connection to ${cfg.host}:${cfg.port}`)
    }
  }

  async noop(): Promise<void> {
    // imapflow rejects with "Connection not available" when the pooled socket
    // died (server idle timeout, NAT drop) — exactly what we want to detect.
    await this.client.noop()
  }

  async close(): Promise<void> {
    try {
      // MUST be awaited: logout() on a dead connection rejects, and an
      // un-awaited rejection escapes the try/catch as unhandled and kills
      // the whole process (reproduced: sync against a dropped IMAP socket).
      await this.client.logout()
    } catch {
      try {
        this.client.close()
      } catch {
        /* already closed */
      }
    }
  }

  async listFolders(): Promise<TransportFolder[]> {
    try {
      const boxes = await this.client.list()
      const out: TransportFolder[] = []
      for (const box of boxes) {
        let specialUse: string | null = null
        if (box.specialUse && typeof box.specialUse === 'string') {
          specialUse = box.specialUse.replace(/^\\/, '').toLowerCase()
        }
        let totalCount = 0
        let unreadCount = 0
        try {
          const status = await this.client.status(box.path, { messages: true, unseen: true })
          totalCount = status?.messages ?? 0
          unreadCount = status?.unseen ?? 0
        } catch {
          /* some servers reject STATUS on certain folders */
        }
        out.push({
          path: box.path,
          delimiter: box.delimiter ?? '/',
          specialUse,
          totalCount,
          unreadCount,
        })
      }
      return out
    } catch (err) {
      throw mapConnError(err, 'LIST')
    }
  }

  async syncFolder(path: string, knownUidvalidity: number | null, sinceUid: number, limit: number): Promise<SyncResult> {
    try {
      const status = await this.client.status(path, { uidValidity: true, messages: true, unseen: true })
      const uidvalidity = Number(status?.uidValidity ?? 0)
      const uidNext = Number(status?.uidNext ?? 0)
      const totalCount = Number(status?.messages ?? 0)
      const unreadCount = Number(status?.unseen ?? 0)
      const fullResync = uidvalidity !== knownUidvalidity

      const newMessages: EnvelopeData[] = []
      const flags = new Map<number, { seen: boolean; flagged: boolean; answered: boolean; deleted: boolean; draft: boolean }>()

      const lock = await this.client.getMailboxLock(path)
      try {
        let range: string
        if (fullResync || sinceUid === 0) {
          const from = Math.max(1, uidNext - limit)
          range = `${from}:*`
        } else {
          range = `${sinceUid + 1}:*`
        }
        for await (const msg of this.client.fetch(
          range,
          { uid: true, envelope: true, flags: true, size: true, bodyStructure: true },
          { uid: true },
        )) {
          const env: ImapFlowEnvelope | undefined = msg.envelope ?? undefined
          const uid = msg.uid
          if (!fullResync && sinceUid > 0 && uid <= sinceUid) continue // x:* quirk
          const fl = msg.flags ?? new Set<string>()
          newMessages.push({
            uid,
            messageId: env?.messageId ? env.messageId.replace(/[<>]/g, '') : null,
            subject: env?.subject ?? '',
            from: toAddresses(env?.from),
            replyTo: toAddresses(env?.replyTo),
            to: toAddresses(env?.to),
            cc: toAddresses(env?.cc),
            date: env?.date instanceof Date ? env.date.getTime() : null,
            size: msg.size ?? 0,
            seen: fl.has('\\Seen'),
            flagged: fl.has('\\Flagged'),
            answered: fl.has('\\Answered'),
            deleted: fl.has('\\Deleted'),
            draft: fl.has('\\Draft'),
            hasAttachments: msg.bodyStructure ? hasAttachmentNode(msg.bodyStructure as { disposition?: string; childNodes?: unknown[] }) : false,
            inReplyTo: env?.inReplyTo ? env.inReplyTo.replace(/[<>]/g, '') : null,
          })
        }
        // Refresh flags for known range (bounded by highest cached uid).
        if (!fullResync && sinceUid > 0) {
          for await (const msg of this.client.fetch(`1:${sinceUid}`, { uid: true, flags: true }, { uid: true })) {
            const fl = msg.flags ?? new Set<string>()
            flags.set(msg.uid, {
              seen: fl.has('\\Seen'),
              flagged: fl.has('\\Flagged'),
              answered: fl.has('\\Answered'),
              deleted: fl.has('\\Deleted'),
              draft: fl.has('\\Draft'),
            })
          }
        }
      } finally {
        lock.release()
      }

      newMessages.sort((a, b) => b.uid - a.uid)
      return { uidvalidity, newMessages, flags, totalCount, unreadCount }
    } catch (err) {
      throw mapConnError(err, `SYNC ${path}`)
    }
  }

  async fetchMessageSource(path: string, uid: number): Promise<Buffer | null> {
    try {
      const lock = await this.client.getMailboxLock(path)
      try {
        const msg = await this.client.fetchOne(String(uid), { uid: true, source: true }, { uid: true })
        if (!msg || !msg.source) return null
        return Buffer.from(msg.source)
      } finally {
        lock.release()
      }
    } catch (err) {
      throw mapConnError(err, `FETCH ${path}#${uid}`)
    }
  }

  async listUids(path: string): Promise<number[]> {
    try {
      const lock = await this.client.getMailboxLock(path)
      try {
        const uids: number[] = []
        for await (const msg of this.client.fetch('1:*', { uid: true }, { uid: true })) {
          uids.push(msg.uid)
        }
        return uids
      } finally {
        lock.release()
      }
    } catch (err) {
      throw mapConnError(err, `UIDLIST ${path}`)
    }
  }

  async updateFlags(path: string, uid: number, patch: { add?: string[]; remove?: string[] }): Promise<void> {
    try {
      const lock = await this.client.getMailboxLock(path)
      try {
        if (patch.add?.length) await this.client.messageFlagsAdd(String(uid), patch.add, { uid: true })
        if (patch.remove?.length) await this.client.messageFlagsRemove(String(uid), patch.remove, { uid: true })
      } finally {
        lock.release()
      }
    } catch (err) {
      throw mapConnError(err, `STORE ${path}#${uid}`)
    }
  }

  async moveMessage(path: string, uid: number, destPath: string): Promise<void> {
    try {
      const lock = await this.client.getMailboxLock(path)
      try {
        await this.client.messageMove(String(uid), destPath, { uid: true })
      } finally {
        lock.release()
      }
    } catch (err) {
      throw mapConnError(err, `MOVE ${path}#${uid} → ${destPath}`)
    }
  }

  async expungeMessage(path: string, uid: number): Promise<void> {
    try {
      const lock = await this.client.getMailboxLock(path)
      try {
        // With UIDPLUS this is a precise UID EXPUNGE. Without it, imapflow
        // falls back to plain EXPUNGE, which also purges any OTHER messages
        // currently flagged \Deleted in this folder (standard IMAP semantics —
        // those messages were marked for deletion by whoever flagged them).
        // Documented residual risk for legacy non-UIDPLUS servers; local cache
        // stays consistent via remote-expunge reconciliation.
        await this.client.messageDelete(String(uid), { uid: true })
      } finally {
        lock.release()
      }
    } catch (err) {
      throw mapConnError(err, `EXPUNGE ${path}#${uid}`)
    }
  }

  async appendMessage(path: string, raw: Buffer, flags: string[]): Promise<number | null> {
    try {
      const res = await this.client.append(path, raw, flags)
      return res && typeof res.uid === 'number' ? res.uid : null
    } catch (err) {
      throw mapConnError(err, `APPEND ${path}`)
    }
  }

  async createFolder(path: string): Promise<void> {
    try {
      await this.client.mailboxCreate(path)
    } catch (err) {
      throw mapConnError(err, `CREATE ${path}`)
    }
  }

  async renameFolder(path: string, newPath: string): Promise<void> {
    try {
      await this.client.mailboxRename(path, newPath)
    } catch (err) {
      throw mapConnError(err, `RENAME ${path}`)
    }
  }

  async deleteFolder(path: string): Promise<void> {
    try {
      await this.client.mailboxDelete(path)
    } catch (err) {
      throw mapConnError(err, `DELETE ${path}`)
    }
  }
}

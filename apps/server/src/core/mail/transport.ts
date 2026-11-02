import type { Address } from '../types.js'

export interface TransportFolder {
  path: string
  delimiter: string
  specialUse: string | null
  totalCount: number
  /** 0 when the server does not report it. */
  unreadCount: number
}

export interface EnvelopeData {
  uid: number
  messageId: string | null
  subject: string
  from: Address[]
  /** Reply-To from the envelope; empty when the sender did not set one. */
  replyTo: Address[]
  to: Address[]
  cc: Address[]
  date: number | null
  size: number
  seen: boolean
  flagged: boolean
  answered: boolean
  draft: boolean
  deleted: boolean
  hasAttachments: boolean
  inReplyTo: string | null
}

export interface SyncResult {
  uidvalidity: number
  /** New messages, newest first. */
  newMessages: EnvelopeData[]
  /** uid -> flags map covering every cached UID (when server cooperated). */
  flags: Map<number, { seen: boolean; flagged: boolean; answered: boolean; deleted: boolean; draft: boolean }>
  totalCount: number
  unreadCount: number
}

/**
 * Interface between the engine and a mailbox server. Production uses IMAP
 * (imapflow); tests provide in-memory fakes. All methods throw AppError with
 * code mail_connection / mail_protocol on failure.
 */
export interface MailTransport {
  close(): Promise<void>
  /** Cheap connection health probe (IMAP NOOP); rejects when the connection is dead. */
  noop(): Promise<void>
  listFolders(): Promise<TransportFolder[]>
  /**
   * Fetch new envelopes (uid > sinceUid), plus flag states for known UIDs.
   * If uidvalidity differs from `knownUidvalidity`, returns a full window of
   * the `limit` newest messages and the caller must drop cached state.
   */
  syncFolder(path: string, knownUidvalidity: number | null, sinceUid: number, limit: number): Promise<SyncResult>
  /** Full RFC822 source of one message, or null when absent. */
  fetchMessageSource(path: string, uid: number): Promise<Buffer | null>
  /** All UIDs currently present in the folder (used to detect remote expunges). */
  listUids(path: string): Promise<number[]>
  updateFlags(path: string, uid: number, patch: { add?: string[]; remove?: string[] }): Promise<void>
  moveMessage(path: string, uid: number, destPath: string): Promise<void>
  expungeMessage(path: string, uid: number): Promise<void>
  /** APPEND a raw message; returns the assigned UID, or null when unknown. */
  appendMessage(path: string, raw: Buffer, flags: string[]): Promise<number | null>
  createFolder(path: string): Promise<void>
  renameFolder(path: string, newPath: string): Promise<void>
  deleteFolder(path: string): Promise<void>
}

export interface TransportConfig {
  host: string
  port: number
  tls: 'tls' | 'starttls' | 'none'
  user: string
  password: string
}

export type TransportFactory = (imap: TransportConfig) => Promise<MailTransport>

export interface SmtpSendResult {
  messageId: string
  accepted: string[]
  rejected: string[]
}

export type SmtpSender = (
  smtp: TransportConfig,
  raw: Buffer,
  envelope: { from: string; to: string[] },
  messageId: string,
) => Promise<SmtpSendResult>

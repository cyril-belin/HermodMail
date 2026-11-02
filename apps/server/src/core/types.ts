/** Permission scopes for API tokens (agents) and programmatic access. */
export const SCOPES = {
  mailRead: 'mail:read',
  mailWrite: 'mail:write',
  mailSend: 'mail:send',
  mailDelete: 'mail:delete',
  folderWrite: 'folder:write',
  folderDelete: 'folder:delete',
  aiUse: 'ai:use',
  admin: 'admin',
} as const

export type Scope = (typeof SCOPES)[keyof typeof SCOPES]

export const ALL_SCOPES: Scope[] = Object.values(SCOPES)

/**
 * Identity under which an operation runs. Every engine method receives an
 * AuthContext and enforces ownership + scopes itself: the HTTP layer and the
 * MCP server are untrusted thin adapters.
 */
export interface AuthContext {
  userId: string
  isAdmin: boolean
  kind: 'web' | 'token'
  scopes: ReadonlySet<string>
}

export interface Address {
  name?: string
  email: string
}

export interface PublicUser {
  id: string
  email: string
  displayName: string
  isAdmin: boolean
  createdAt: number
}

export interface ApiTokenInfo {
  id: string
  name: string
  scopes: string[]
  createdAt: number
  lastUsedAt: number | null
}

export interface MailAccountInput {
  name: string
  email: string
  imap: { host: string; port: number; tls: 'tls' | 'starttls' | 'none'; user: string; password: string }
  smtp: { host: string; port: number; tls: 'tls' | 'starttls' | 'none'; user?: string; password?: string }
}

export interface MailAccountInfo {
  id: string
  name: string
  email: string
  imap: { host: string; port: number; tls: string; user: string }
  smtp: { host: string; port: number; tls: string; user: string }
  createdAt: number
  lastSyncAt: number | null
}

export interface FolderInfo {
  id: string
  path: string
  delimiter: string
  specialUse: string | null
  totalCount: number
  unreadCount: number
  lastSyncAt: number | null
}

export interface AttachmentMeta {
  id: string
  filename: string
  contentType: string
  size: number
}

export interface MessageSummary {
  id: string
  accountId: string
  folderId: string
  folderPath: string
  uid: number
  messageId: string | null
  subject: string
  from: Address[]
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
  snippet: string
  summary?: string | null
}

/** Languages the UI and the AI translator support. */
export const UI_LOCALES = ['fr', 'en', 'es'] as const
export type UiLocale = (typeof UI_LOCALES)[number]

export function isUiLocale(value: string): value is UiLocale {
  return (UI_LOCALES as readonly string[]).includes(value)
}

/**
 * A cached, user-triggered translation of a message. The original message on
 * the IMAP server is never modified — this only lives in the local cache.
 */
export interface TranslationExtra {
  /** ISO code of the detected source language ('unknown' when undetectable). */
  from: string
  target: UiLocale
  /** Plain-text translation (when the message has no usable HTML body). */
  text?: string
  /** HTML translation, re-sanitized before storage. */
  html?: string
  createdAt: number
}

export interface MessageDetail extends MessageSummary {
  bodyText: string | null
  bodyHtml: string | null
  attachments: AttachmentMeta[]
  /** Conversation threading: In-Reply-To of this message plus the References chain. */
  inReplyTo?: string | null
  references: string[]
  classification?: string | null
  draftReply?: string | null
  translation?: TranslationExtra | null
}

export interface SendMessageInput {
  accountId: string
  to: Address[]
  cc?: Address[]
  bcc?: Address[]
  subject: string
  text?: string
  html?: string
  inReplyTo?: string
  references?: string[]
  attachments?: { filename: string; contentType: string; contentBase64: string }[]
}

/** A correspondent harvested from mail traffic or created manually. */
export interface ContactInfo {
  id: string
  email: string
  name: string
  /** 'auto' = harvested from messages (name may be refreshed); 'manual' = user-owned. */
  source: 'auto' | 'manual'
  messageCount: number
  lastMessageAt: number | null
  createdAt: number
  updatedAt: number
}

/** Save a real IMAP draft (\Draft) in the account's Drafts folder. Nothing is sent. */
export interface SaveDraftInput {
  accountId: string
  to?: Address[]
  cc?: Address[]
  bcc?: Address[]
  subject?: string
  text?: string
  html?: string
  inReplyTo?: string
  references?: string[]
}

export interface SaveDraftResult {
  ok: boolean
  folder: string
  uid: number | null
  id: string | null
}

export interface ListMessagesQuery {
  folder: string
  page?: number
  limit?: number
  filter?: 'all' | 'unseen' | 'flagged' | 'attachments'
  q?: string
}

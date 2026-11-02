export interface Address { name?: string; email: string }

export interface PublicUser {
  id: string; email: string; displayName: string; isAdmin: boolean; createdAt: number
}

export interface ApiTokenInfo {
  id: string; name: string; scopes: string[]; createdAt: number; lastUsedAt: number | null
}

export interface MailAccountInfo {
  id: string; name: string; email: string
  imap: { host: string; port: number; tls: string; user: string }
  smtp: { host: string; port: number; tls: string; user: string }
  createdAt: number; lastSyncAt: number | null
}

export interface FolderInfo {
  id: string; path: string; delimiter: string; specialUse: string | null
  totalCount: number; unreadCount: number; lastSyncAt: number | null
}

export interface AttachmentMeta { id: string; filename: string; contentType: string; size: number }

export interface MessageSummary {
  id: string; accountId: string; folderId: string; folderPath: string; uid: number
  messageId: string | null; subject: string
  from: Address[]; replyTo: Address[]; to: Address[]; cc: Address[]
  date: number | null; size: number
  seen: boolean; flagged: boolean; answered: boolean; draft: boolean; deleted: boolean
  hasAttachments: boolean; snippet: string; summary?: string | null
}

export interface MessageDetail extends MessageSummary {
  bodyText: string | null; bodyHtml: string | null
  attachments: AttachmentMeta[]
  inReplyTo?: string | null; references: string[]
  classification?: string | null; draftReply?: string | null
  /** Cached AI translation (original IMAP message is never modified). */
  translation?: { from: string; target: string; text?: string; html?: string; createdAt: number } | null
}

export interface UserSettings {
  /** Polling interval in ms; 0 = manual only. */
  refreshIntervalMs: number
  /** Explicit UI language choice ('fr' | 'en' | 'es'); '' = none yet. */
  locale: string
}

export interface ContactInfo {
  id: string; email: string; name: string
  source: 'auto' | 'manual'; messageCount: number; lastMessageAt: number | null
  createdAt: number; updatedAt: number
}

export interface SaveDraftResult {
  ok: boolean; folder: string; uid: number | null; id: string | null
}

/** Labels are localized at render time (see i18n keys settings.refresh_*). */
export const REFRESH_INTERVAL_VALUES = [0, 30_000, 60_000, 120_000, 300_000, 600_000] as const

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  })
  const contentType = res.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    if (!res.ok) throw new ApiError(res.status, 'http_error', `HTTP ${res.status}`)
    return (await res.text()) as unknown as T
  }
  const json = (await res.json()) as { error?: { code: string; message: string } }
  if (!res.ok) {
    throw new ApiError(res.status, json.error?.code ?? 'http_error', json.error?.message ?? `HTTP ${res.status}`)
  }
  return json as T
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown) => request<T>('POST', url, body),
  put: <T>(url: string, body?: unknown) => request<T>('PUT', url, body),
  patch: <T>(url: string, body?: unknown) => request<T>('PATCH', url, body),
  delete: <T>(url: string) => request<T>('DELETE', url),
}

export interface AiSettings {
  provider: 'none' | 'ollama' | 'openai'; baseUrl: string; model: string; systemHint: string
}

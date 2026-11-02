import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export interface Config {
  port: number
  host: string
  /** Directory holding the SQLite database, secret key and attachments. */
  dataDir: string
  /** Master key used to derive account-credential encryption keys. */
  masterSecret: Buffer
  /** Absolute path to the built web client (production). */
  webDist: string | undefined
  trustProxy: boolean
  /** Set the Secure flag on session cookies. Opt-in: HERMODMAIL_COOKIE_SECURE=1
   *  (only enable when the app is reached over HTTPS, or login breaks on plain HTTP). */
  cookieSecure: boolean
  sessionTtlHours: number
  /** Max messages fetched on first folder sync. */
  initialSyncLimit: number
  /** Max recent messages whose body gets indexed for full-text search. */
  bodyIndexLimit: number
  /** Max attachment size (bytes) stored in the database. */
  maxAttachmentSize: number
}

function readOrCreateSecret(dataDir: string, envSecret: string | undefined): { secret: Buffer; generated: boolean } {
  if (envSecret) {
    const buf = Buffer.from(envSecret, 'utf8')
    if (buf.length < 32) {
      throw new Error('HERMODMAIL_SECRET must be at least 32 characters')
    }
    return { secret: buf, generated: false }
  }
  const file = path.join(dataDir, 'secret.key')
  if (fs.existsSync(file)) {
    const secret = fs.readFileSync(file)
    if (secret.length >= 32) return { secret, generated: false }
    throw new Error(`Corrupt secret file at ${file}; delete it or set HERMODMAIL_SECRET`)
  }
  const secret = randomBytes(32)
  fs.writeFileSync(file, secret, { mode: 0o600 })
  return { secret, generated: true }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = path.resolve(env.HERMODMAIL_DATA_DIR ?? './data')
  fs.mkdirSync(dataDir, { recursive: true })
  const { secret } = readOrCreateSecret(dataDir, env.HERMODMAIL_SECRET)
  const webDist = env.HERMODMAIL_WEB_DIST ? path.resolve(env.HERMODMAIL_WEB_DIST) : undefined
  return {
    port: Number(env.PORT ?? 8667),
    host: env.HOST ?? '127.0.0.1',
    dataDir,
    masterSecret: secret,
    webDist,
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
    cookieSecure: env.HERMODMAIL_COOKIE_SECURE === '1' || env.HERMODMAIL_COOKIE_SECURE === 'true',
    sessionTtlHours: Number(env.SESSION_TTL_HOURS ?? 24 * 14),
    initialSyncLimit: Number(env.INITIAL_SYNC_LIMIT ?? 200),
    bodyIndexLimit: Number(env.BODY_INDEX_LIMIT ?? 300),
    maxAttachmentSize: Number(env.MAX_ATTACHMENT_SIZE ?? 5 * 1024 * 1024),
  }
}

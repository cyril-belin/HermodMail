import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto'

// OWASP Password Storage Cheat Sheet recommends scrypt N >= 2^17, r = 8, p = 1.
// Parameters are embedded in the stored hash, so raising them here only affects
// NEW hashes; previously stored hashes keep verifying with their own parameters.
const SCRYPT_N = 131072
const SCRYPT_r = 8
const SCRYPT_p = 1
const KEY_LEN = 32
// Node's default maxmem (32 MiB) rejects N=2^17 (needs ~134 MiB).
const SCRYPT_MAXMEM = 256 * 1024 * 1024

/** Hash a user password with scrypt. Format: scrypt$N$r$p$saltB64$hashB64 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(password.normalize('NFKC'), salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p, maxmem: SCRYPT_MAXMEM })
  return `scrypt$${SCRYPT_N}$${SCRYPT_r}$${SCRYPT_p}$${salt.toString('base64')}$${hash.toString('base64')}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const N = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p) || N < 16384) return false
  const salt = Buffer.from(parts[4]!, 'base64')
  const expected = Buffer.from(parts[5]!, 'base64')
  // scrypt is a stream: a truncated hash's prefix is a valid shorter key.
  // Refuse anything that is not exactly the canonical key length.
  if (expected.length !== KEY_LEN || salt.length !== 16) return false
  const actual = scryptSync(password.normalize('NFKC'), salt, expected.length, { N, r, p, maxmem: SCRYPT_MAXMEM })
  return timingSafeEqual(actual, expected)
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex')
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

/** Derive a purpose-specific subkey from the master secret (domain separation). */
function deriveKey(masterSecret: Buffer, purpose: string): Buffer {
  return createHmac('sha256', masterSecret).update(`hermodmail:v1:${purpose}`).digest()
}

const ENC_PREFIX = 'enc1'

/** Encrypt a secret with AES-256-GCM. Format: enc1.ivB64.tagB64.ctB64 */
export function encryptSecret(plaintext: string, masterSecret: Buffer): string {
  const key = deriveKey(masterSecret, 'credentials')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [ENC_PREFIX, iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join('.')
}

export function decryptSecret(encrypted: string, masterSecret: Buffer): string {
  const parts = encrypted.split('.')
  if (parts.length !== 4 || parts[0] !== ENC_PREFIX) {
    throw new Error('Invalid encrypted secret format')
  }
  const key = deriveKey(masterSecret, 'credentials')
  const iv = Buffer.from(parts[1]!, 'base64')
  const tag = Buffer.from(parts[2]!, 'base64')
  const ct = Buffer.from(parts[3]!, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

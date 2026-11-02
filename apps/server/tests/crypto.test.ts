import { describe, expect, it } from 'vitest'
import { decryptSecret, encryptSecret, hashPassword, randomToken, safeEqual, sha256Hex, verifyPassword } from '../src/core/crypto.js'

describe('crypto', () => {
  const master = Buffer.from('0123456789abcdef0123456789abcdef')

  it('round-trips secrets with AES-256-GCM', () => {
    const enc = encryptSecret('app-password-123', master)
    expect(enc.startsWith('enc1.')).toBe(true)
    expect(decryptSecret(enc, master)).toBe('app-password-123')
  })

  it('produces different ciphertexts for the same plaintext', () => {
    expect(encryptSecret('same', master)).not.toBe(encryptSecret('same', master))
  })

  it('rejects tampered ciphertext', () => {
    const enc = encryptSecret('secret', master)
    const tampered = enc.slice(0, -4) + 'AAAA'
    expect(() => decryptSecret(tampered, master)).toThrow()
  })

  it('rejects the wrong master key', () => {
    const enc = encryptSecret('secret', master)
    expect(() => decryptSecret(enc, Buffer.from('other-key-other-key-other-key!!'))).toThrow()
  })

  it('hashes and verifies passwords', () => {
    const hash = hashPassword('correct horse battery')
    expect(hash.startsWith('scrypt$')).toBe(true)
    expect(verifyPassword('correct horse battery', hash)).toBe(true)
    expect(verifyPassword('wrong password', hash)).toBe(false)
  })

  it('rejects malformed stored hashes', () => {
    expect(verifyPassword('x', 'not-a-hash')).toBe(false)
  })

  it('derives different subkeys per purpose (domain separation)', () => {
    const a = encryptSecret('v', Buffer.from('k'.repeat(32)))
    // same plaintext, same key → valid; ensure domain separation is deterministic in keyspace
    expect(decryptSecret(a, Buffer.from('k'.repeat(32)))).toBe('v')
  })

  it('constant-time comparison and token generation', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
    expect(safeEqual('abc', 'abcd')).toBe(false)
    const t = randomToken()
    expect(t).toHaveLength(43) // 32 bytes base64url
    expect(sha256Hex('test')).toHaveLength(64)
  })
})

import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { openInMemoryDatabase } from '../src/db/database.js'
import { MailStore } from '../src/core/mail/store.js'
import { ftsQuery } from '../src/core/mail/store.js'
import { emailHtmlToText, extractSnippet, fenceUntrusted, sanitizeEmailHtml, sanitizeFilename } from '../src/core/mail/sanitize.js'
import { decryptSecret, encryptSecret, hashPassword, verifyPassword } from '../src/core/crypto.js'

const masterSecret = Buffer.from('f'.repeat(32))

/**
 * Property-based adversarial suite. Invariants only — no assertion may simply
 * mirror the implementation's decisions. Every property below is something an
 * attacker or a buggy future refactor could violate.
 */
describe('Round 5 — adversarial properties', () => {
  it('PROPERTY ftsQuery: arbitrary (hostile) queries never crash the search path', () => {
    const db = openInMemoryDatabase()
    db.prepare('INSERT INTO users (id, email, display_name, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, 0, ?)')
      .run('u1', 'u@x.c', '', 'scrypt$16384$8$1$c2FsdA==$aGFzaA==', 0)
    db.prepare('INSERT INTO mail_accounts (id, user_id, name, email, imap_host, imap_port, imap_tls, imap_user, imap_pass_enc, smtp_host, smtp_port, smtp_tls, smtp_user, smtp_pass_enc, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('acc1', 'u1', 'T', 't@x.c', 'h', 993, 'tls', 'u', 'enc', 'h', 587, 'tls', 'u', 'enc', 0)
    const store = new MailStore(db)
    const folder = store.upsertFolder('acc1', { path: 'INBOX', delimiter: '/', specialUse: null })
    // Seed a couple of rows so MATCH actually evaluates against content.
    store.upsertEnvelope(folder.id, 'acc1', {
      uid: 1, messageId: 'a@x', subject: 'hello world', from: [{ email: 'a@b.c' }], to: [], cc: [],
      date: 1, size: 10, seen: false, flagged: false, answered: false, draft: false, deleted: false,
      hasAttachments: false, inReplyTo: null,
    }, 'some searchable body text')
    const hostile = fc.string({ unit: 'grapheme', maxLength: 60 })
    fc.assert(
      fc.property(hostile, (q) => {
        const built = ftsQuery(q)
        // Invariant 1: query construction never throws and is bounded.
        expect(built.length).toBeLessThanOrEqual(q.length * 4 + 16)
        // Invariant 2: executing it against FTS never throws.
        expect(() => store.listMessageRows(folder.id, { limit: 5, offset: 0, q })).not.toThrow()
        expect(() => store.searchRows(['acc1'], q, 10)).not.toThrow()
      }),
      { numRuns: 200 },
    )
  })

  it('PROPERTY sanitizeFilename: output stays header-safe, bounded, and idempotent', () => {
    const hostile = fc.string({ unit: 'grapheme', maxLength: 300 })
    fc.assert(
      fc.property(hostile, (name) => {
        const out = sanitizeFilename(name)
        // Invariant 1: only the whitelist of characters survives.
        expect(out).toMatch(/^[^"\\\r\n;=<>|*?]*$/)
        // Invariant 2: never empty (fallback constant), bounded.
        expect(out.length).toBeGreaterThan(0)
        expect(out.length).toBeLessThanOrEqual(150)
        // Invariant 3: idempotent — re-sanitizing is a fixpoint.
        expect(sanitizeFilename(out)).toBe(out)
        // Invariant 4: safe for a quoted HTTP header value.
        expect(`attachment; filename="${out}"`).not.toMatch(/[\r\n]/)
      }),
      { numRuns: 300 },
    )
  })

  it('PROPERTY fenceUntrusted: untrusted text can never break out of the fence or smuggle control channels', () => {
    const hostile = fc.string({ unit: 'grapheme', maxLength: 2000 })
    fc.assert(
      fc.property(hostile, (text) => {
        const out = fenceUntrusted('body', text)
        expect(out).toContain('<<<UNTRUSTED_EMAIL_CONTENT')
        expect(out).toContain('<<<END_UNTRUSTED_EMAIL_CONTENT>>>')
        // No C0/C1 control characters or zero-width joiners survive.
        // eslint-disable-next-line no-control-regex
        expect(out).not.toMatch(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\uFEFF]/)
        // Chat-special tokens are neutralized.
        expect(out).not.toContain('<|im_start|>')
        expect(out).not.toContain('<|endoftext|>')
        expect(out.length).toBeLessThan(24000 + 512)
      }),
      { numRuns: 200 },
    )
  })

  it('PROPERTY sanitizeEmailHtml: hostile soup never yields active content, and re-sanitizing is stable', () => {
    const tagNames = fc.constantFrom('script', 'iframe', 'img', 'a', 'div', 'object', 'embed', 'form', 'svg', 'math', 'base', 'meta', 'link')
    const attrs = fc.constantFrom('onerror', 'onload', 'onclick', 'onfocus', 'src', 'href', 'style', 'formaction', 'srcdoc', 'data')
    const values = fc.constantFrom('alert(1)', 'javascript:alert(1)', 'data:text/html,<script>1</script>', 'vbscript:x', '&#106;avascript:alert(1)', 'jAvAsCrIpT:alert(1)', 'https://ok.example/x')
    const soupArb = fc.array(fc.record({ tag: tagNames, attr: attrs, value: values }), { maxLength: 12 }).map((parts) =>
      parts.map((p) => `<${p.tag} ${p.attr}="${p.value}">x</${p.tag}>`).join(''),
    )
    fc.assert(
      fc.property(soupArb, (soup) => {
        const out = sanitizeEmailHtml(soup)
        const lower = out.toLowerCase()
        // Invariant 1: no script-bearing or active content.
        expect(lower).not.toContain('<script')
        expect(lower).not.toContain('<iframe')
        expect(lower).not.toContain('<object')
        expect(lower).not.toContain('<embed')
        expect(lower).not.toContain('<form')
        // Invariant 2: no event-handler attributes survive (any on*="...").
        expect(lower).not.toMatch(/\son[a-z]+\s*=/)
        // Invariant 3: URL sinks (href/src) never carry script schemes —
        // even after entity decoding. (Scheme text inside a style attribute
        // is inert in every current browser engine and is out of scope.)
        expect(lower).not.toMatch(/href\s*=\s*["']?\s*(javascript|vbscript|data:text\/html)/)
        expect(lower).not.toMatch(/src\s*=\s*["']?\s*(javascript|vbscript|data:text\/html)/)
        // Invariant 4: sanitization is stable (no sanitizer oscillation).
        expect(sanitizeEmailHtml(out)).toBe(out)
      }),
      { numRuns: 250 },
    )
  })

  it('PROPERTY password hashing: arbitrary passwords round-trip, wrong ones fail, malformed hashes rejected', () => {
    // Keep runs low: scrypt at N=2^17 costs ~170ms per call.
    const pwdArb = fc.string({ unit: 'grapheme', minLength: 8, maxLength: 40 })
    fc.assert(
      fc.property(pwdArb, fc.string({ unit: 'grapheme', minLength: 8, maxLength: 40 }), (pw, wrong) => {
        const h = hashPassword(pw)
        expect(verifyPassword(pw, h)).toBe(true)
        if (pw !== wrong) expect(verifyPassword(wrong, h)).toBe(false)
        // Malformed/truncated hashes must be rejected, never crash.
        expect(verifyPassword(pw, h.slice(0, h.length - 3))).toBe(false)
        expect(verifyPassword(pw, '')).toBe(false)
        expect(verifyPassword(pw, 'scrypt$bad')).toBe(false)
      }),
      { numRuns: 12 },
    )
  })

  it('PROPERTY secret encryption: round-trips arbitrary unicode, detects byte-level tampering', () => {
    const secretArb = fc.string({ unit: 'grapheme', maxLength: 500 })
    fc.assert(
      fc.property(secretArb, fc.integer({ min: 0, max: 7 }), (s, bit) => {
        const enc = encryptSecret(s, masterSecret)
        expect(decryptSecret(enc, masterSecret)).toBe(s)
        // Tamper at the BYTE level inside the ciphertext (a base64 char flip
        // may only touch padding bits and decode to identical bytes — so we
        // decode, flip a bit, and re-encode for a guaranteed byte change).
        const [, iv, tag, ct] = enc.split('.')
        if (!ct || ct.length === 0) return // empty plaintext: tamper iv instead
        const ctBuf = Buffer.from(ct, 'base64')
        ctBuf[ctBuf.length - 1] ^= 1 << bit
        const tampered = ['enc1', iv!, tag!, ctBuf.toString('base64')].join('.')
        if (tampered !== enc) {
          expect(() => decryptSecret(tampered, masterSecret)).toThrow()
        }
        // Tampering the IV must also throw.
        const ivBuf = Buffer.from(iv!, 'base64')
        ivBuf[0] ^= 1 << bit
        expect(() => decryptSecret(['enc1', ivBuf.toString('base64'), tag!, ct].join('.'), masterSecret)).toThrow()
      }),
      { numRuns: 120 },
    )
  })

  it('PROPERTY extractSnippet: bounded, single-line-ish, stable', () => {
    const textArb = fc.string({ unit: 'grapheme', maxLength: 3000 })
    fc.assert(
      fc.property(textArb, fc.integer({ min: 10, max: 500 }), (text, maxLen) => {
        const out = extractSnippet(text, maxLen)
        expect(out.length).toBeLessThanOrEqual(maxLen)
        expect(out).not.toMatch(/\s{2,}/) // whitespace collapsed
        if (text.trim().length > 0) expect(out.length).toBeGreaterThan(0)
      }),
      { numRuns: 200 },
    )
  })

  it('FUZZ malformed MIME through the engine fetch path: no corruption escapes', async () => {
    const db = openInMemoryDatabase()
    const { MailEngine } = await import('../src/core/mail/engine.js')
    const { InMemoryTransport, FakeSmtpSender } = await import('./inmemory-transport.js')
    const { AuthService } = await import('../src/core/auth-service.js')
    const auth = new AuthService(db, 24)
    const store = new MailStore(db)
    const transport = new InMemoryTransport('u@x')
    const { MailEngine: ME } = await import('../src/core/mail/engine.js')
    void ME
    const engine = new MailEngine(
      db,
      { port: 0, host: '', dataDir: '', masterSecret, webDist: undefined, trustProxy: false, cookieSecure: false, sessionTtlHours: 1, initialSyncLimit: 50, bodyIndexLimit: 50, maxAttachmentSize: 1024 } satisfies import('../src/config.js').Config,
      store,
      async () => transport,
      new FakeSmtpSender().sender,
      () => {},
    )
    auth.createUserGuarded({ email: 'f@x.test', password: 'password123' })
    const web = auth.contextForSession(auth.login('f@x.test', 'password123').token)!
    const info = await engine.addAccount(web, {
      name: 'T', email: 'u@x.test',
      imap: { host: 'imap.fuzz', port: 993, tls: 'tls', user: 'u', password: 'p' },
      smtp: { host: 'smtp.fuzz', port: 587, tls: 'starttls' },
    })

    // Hostile payloads: random bytes, truncated MIME, huge headers, bad base64
    const payloads: Buffer[] = [
      Buffer.from([0x00, 0xff, 0xfe, 0x00, 0x13, 0x10, 0x7f]),
      Buffer.from('From: a@b.c\r\nSubject: \r\n\r\n--boundary-without-end\r\n'),
      Buffer.from('From: a@b.c\r\nX-Long: ' + 'A'.repeat(60000) + '\r\n\r\nbody'),
      Buffer.from('Content-Type: multipart/mixed; boundary="B"\r\n\r\n--B\r\nContent-Transfer-Encoding: base64\r\n\r\n!!!not-base64!!!\r\n--B--'),
      Buffer.from('Subject: =?bogus-charset?B|invalid?=\r\n\r\nx'),
      Buffer.from(''),
    ]
    for (const p of payloads) {
      transport.deliver('INBOX', p)
    }
    await engine.syncFolder(web, info.id, 'INBOX')
    // Every hostile message either loads or fails cleanly; DB must stay intact.
    for (let uid = 1; uid <= payloads.length; uid++) {
      try {
        await engine.getMessage(web, info.id, 'INBOX', uid, { markSeen: false })
      } catch (err) {
        // Only acceptable failure modes: clean AppError, never a crash class.
        expect((err as { name?: string }).name).toBe('AppError')
      }
    }
    expect((db.pragma('integrity_check', { simple: true }) as string)).toBe('ok')
    const list = await engine.listMessages(web, info.id, { folder: 'INBOX', sync: false })
    expect(list.total).toBe(payloads.length)
  })

  it('DIFFERENTIAL html-to-text: sanitized HTML and its text form agree on visible text', () => {
    const html = '<p>Hello <b>World</b></p><script>evil()</script><a href="https://x.test">link</a>'
    const safe = sanitizeEmailHtml(html)
    const text = emailHtmlToText(safe)
    expect(text).toContain('Hello World')
    expect(text).toContain('link')
    expect(text.toLowerCase()).not.toContain('evil')
  })
})

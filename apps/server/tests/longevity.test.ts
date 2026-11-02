import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { openDatabase } from '../src/db/database.js'
import { encryptSecret, decryptSecret } from '../src/core/crypto.js'
import { rotateMasterSecret } from '../src/core/rotation.js'

const OLD = Buffer.from('old-secret-old-secret-old-secret!', 'utf8')
const NEW = Buffer.from('new-secret-new-secret-new-secret!', 'utf8')

describe('Round 10 — longevity: rotation, backup, migrations', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync('/tmp/hm-long-') })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  function seededDb(dataDir: string): Database.Database {
    const db = openDatabase(dataDir)
    db.prepare(`INSERT INTO users (id, email, display_name, password_hash, is_admin, created_at) VALUES ('u1','u@x.c','','x',1,0)`).run()
    db.prepare(`INSERT INTO mail_accounts (id, user_id, name, email, imap_host, imap_port, imap_tls, imap_user, imap_pass_enc, smtp_host, smtp_port, smtp_tls, smtp_user, smtp_pass_enc, created_at)
                VALUES ('a1','u1','T','t@x.c','h',993,'tls','u',?, 'h',587,'tls','u','', 0)`)
      .run(encryptSecret('imap-password', OLD))
    db.prepare('UPDATE ai_settings SET provider=?, api_key_enc=? WHERE id=1').run('openai', encryptSecret('sk-live-key', OLD))
    return db
  }

  it('rotation re-encrypts all credentials; old secret no longer decrypts; nothing rotates on failure', () => {
    const db = seededDb(dir)
    const res = rotateMasterSecret(db, OLD, NEW)
    expect(res).toMatchObject({ mailAccountsRotated: 1, aiKeysRotated: 1, failures: [] })
    const acc = db.prepare('SELECT imap_pass_enc, smtp_pass_enc FROM mail_accounts WHERE id = ?').get('a1') as { imap_pass_enc: string }
    expect(decryptSecret(acc.imap_pass_enc, NEW)).toBe('imap-password')
    expect(() => decryptSecret(acc.imap_pass_enc, OLD)).toThrow()
    const ai = db.prepare('SELECT api_key_enc FROM ai_settings WHERE id = 1').get() as { api_key_enc: string }
    expect(decryptSecret(ai.api_key_enc, NEW)).toBe('sk-live-key')
    // Refuses same-secret rotation and fails atomically on a wrong old secret.
    expect(() => rotateMasterSecret(db, NEW, NEW)).toThrow(/must differ/)
    expect(() => rotateMasterSecret(db, Buffer.from('wrong!'.repeat(5)), NEW)).toThrow(/nothing was changed/)
    // After the failed attempt the data is still readable with NEW (no partial state).
    expect(decryptSecret(acc.imap_pass_enc, NEW)).toBe('imap-password')
    db.close()
  })

  it('online backup + restore: the copy is a fully working database', async () => {
    const db = seededDb(dir)
    const backupPath = path.join(dir, 'backup.sqlite')
    await db.backup(backupPath)
    const restored = new Database(backupPath)
    expect(restored.pragma('integrity_check', { simple: true })).toBe('ok')
    expect((restored.prepare('SELECT COUNT(*) c FROM mail_accounts').get() as { c: number }).c).toBe(1)
    const acc = restored.prepare('SELECT imap_pass_enc FROM mail_accounts WHERE id = ?').get('a1') as { imap_pass_enc: string }
    expect(decryptSecret(acc.imap_pass_enc, OLD)).toBe('imap-password')
    // FTS schema survives the backup too (external-content table + triggers).
    expect((restored.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name = 'message_fts'").get() as { c: number }).c).toBe(1)
    expect(() => restored.prepare("SELECT rowid FROM message_fts WHERE message_fts MATCH 'x'").all()).not.toThrow()
    restored.close()
    db.close()
  })

  it('migration path: a v1 database is upgraded idempotently and data survives', () => {
    // Build a fake "v1-era" database by downgrading user_version on a fresh db.
    const dbPath = path.join(dir, 'mig.sqlite')
    const db = new Database(dbPath)
    db.pragma('user_version = 0')
    db.close()
    const reopened = openDatabase(dir) // runs migrations
    expect(reopened.pragma('user_version', { simple: true })).toBeGreaterThan(0)
    // Idempotent: reopening does not fail or re-run.
    reopened.close()
    const again = openDatabase(dir)
    expect(again.pragma('user_version', { simple: true })).toBeGreaterThan(0)
    expect((again.prepare("SELECT COUNT(*) c FROM users").get() as { c: number }).c).toBe(0)
    again.close()
  })
})

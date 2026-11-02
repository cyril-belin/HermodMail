import type { DB } from '../db/database.js'
import { decryptSecret, encryptSecret } from './crypto.js'

export interface RotationResult {
  mailAccountsRotated: number
  aiKeysRotated: number
  failures: { table: string; id: string; reason: string }[]
}

/**
 * Rotate the master secret: decrypt every stored credential with the old
 * secret and re-encrypt with the new one, in one transaction. After this runs,
 * the process must be restarted with HERMODMAIL_SECRET set to the new value.
 *
 * Encrypted blobs are self-describing (enc1 prefix) but keyed by the derived
 * subkey — a wrong old secret makes decryption fail per-row and the rotation
 * refuses to complete (no partial state).
 */
export function rotateMasterSecret(db: DB, oldSecret: Buffer, newSecret: Buffer): RotationResult {
  if (oldSecret.equals(newSecret)) {
    throw new Error('The new secret must differ from the current one')
  }
  const result: RotationResult = { mailAccountsRotated: 0, aiKeysRotated: 0, failures: [] }

  const accountRows = db
    .prepare('SELECT id, imap_pass_enc, smtp_pass_enc FROM mail_accounts')
    .all() as { id: string; imap_pass_enc: string; smtp_pass_enc: string }[]
  const rotatedAccounts: { id: string; imap: string; smtp: string }[] = []
  for (const row of accountRows) {
    try {
      const imap = encryptSecret(decryptSecret(row.imap_pass_enc, oldSecret), newSecret)
      const smtp = row.smtp_pass_enc ? encryptSecret(decryptSecret(row.smtp_pass_enc, oldSecret), newSecret) : ''
      rotatedAccounts.push({ id: row.id, imap, smtp })
    } catch (err) {
      result.failures.push({ table: 'mail_accounts', id: row.id, reason: err instanceof Error ? err.message : String(err) })
    }
  }

  const aiRow = db.prepare('SELECT id, api_key_enc FROM ai_settings WHERE id = 1').get() as
    | { id: number; api_key_enc: string }
    | undefined
  const aiKey = aiRow && aiRow.api_key_enc !== '' ? aiRow : undefined
  let rotatedAi: { id: number; enc: string } | null = null
  if (aiKey) {
    try {
      rotatedAi = { id: aiKey.id, enc: encryptSecret(decryptSecret(aiKey.api_key_enc, oldSecret), newSecret) }
    } catch (err) {
      result.failures.push({ table: 'ai_settings', id: String(aiKey.id), reason: err instanceof Error ? err.message : String(err) })
    }
  }

  if (result.failures.length > 0) {
    // Never leave half-rotated credentials behind.
    throw new Error(`Rotation failed for ${result.failures.length} row(s); nothing was changed`)
  }

  db.exec('BEGIN')
  try {
    const upd = db.prepare('UPDATE mail_accounts SET imap_pass_enc = ?, smtp_pass_enc = ? WHERE id = ?')
    for (const r of rotatedAccounts) upd.run(r.imap, r.smtp, r.id)
    if (rotatedAi) {
      db.prepare('UPDATE ai_settings SET api_key_enc = ? WHERE id = ?').run(rotatedAi.enc, rotatedAi.id)
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  result.mailAccountsRotated = rotatedAccounts.length
  result.aiKeysRotated = rotatedAi ? 1 : 0
  return result
}

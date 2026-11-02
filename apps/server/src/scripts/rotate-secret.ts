import { loadConfig } from '../config.js'
import { openDatabase } from '../db/database.js'
import { rotateMasterSecret } from '../core/rotation.js'

/**
 * CLI: rotate the master secret.
 *
 *   HERMODMAIL_OLD_SECRET=<old> HERMODMAIL_SECRET=<new> npx tsx src/scripts/rotate-secret.ts
 *
 * Or with a data dir that holds the current secret.key file and HERMODMAIL_SECRET
 * set to the NEW value:
 *   npx tsx src/scripts/rotate-secret.ts
 */
function main(): void {
  const config = loadConfig(process.env)
  const newSecret = config.masterSecret
  let oldSecret: Buffer | undefined
  if (process.env.HERMODMAIL_OLD_SECRET) {
    oldSecret = Buffer.from(process.env.HERMODMAIL_OLD_SECRET, 'utf8')
  } else {
    // Fall back to the previously deployed secret file passed via path.
    const prevPath = process.env.HERMODMAIL_OLD_SECRET_FILE
    if (prevPath) oldSecret = (require('node:fs') as typeof import('node:fs')).readFileSync(prevPath)
  }
  if (!oldSecret) {
    console.error('Set HERMODMAIL_OLD_SECRET (or HERMODMAIL_OLD_SECRET_FILE) and HERMODMAIL_SECRET=<new>.')
    process.exit(2)
  }
  const db = openDatabase(config.dataDir)
  try {
    const res = rotateMasterSecret(db, oldSecret, newSecret)
    console.log(JSON.stringify(res))
    console.log('Rotation complete. Restart HermodMail with the NEW HERMODMAIL_SECRET.')
  } catch (err) {
    console.error('Rotation aborted:', err instanceof Error ? err.message : err)
    process.exit(1)
  } finally {
    db.close()
  }
}

main()

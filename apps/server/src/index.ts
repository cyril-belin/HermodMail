import { loadConfig } from './config.js'
import { openDatabase } from './db/database.js'
import { AuthService } from './core/auth-service.js'
import { MailStore } from './core/mail/store.js'
import { MailEngine } from './core/mail/engine.js'
import { ImapFlowTransport } from './core/mail/imapflow-transport.js'
import { nodemailerSender } from './core/mail/smtp.js'
import { AiProviderRegistry } from './core/ai/provider.js'
import { AiService } from './core/ai/service.js'
import { buildApp } from './http/app.js'
import { registerRoutes } from './http/routes.js'
import { registerMcp } from './mcp/server.js'

async function main(): Promise<void> {
  const config = loadConfig()
  const db = openDatabase(config.dataDir)
  const auth = new AuthService(db, config.sessionTtlHours)
  const store = new MailStore(db)
  const engine = new MailEngine(
    db,
    config,
    store,
    (imap) => ImapFlowTransport.connect(imap),
    nodemailerSender,
    (level, msg, data) => {
      // Minimal structured logging independent of the HTTP logger.
      const line = JSON.stringify({ ts: new Date().toISOString(), level, mod: 'engine', msg, ...data })
      if (level === 'error') console.error(line)
      else if (level === 'warn') console.warn(line)
      else console.log(line)
    },
  )
  const aiRegistry = new AiProviderRegistry(db, config.masterSecret)
  const aiService = new AiService(aiRegistry, store, engine)

  const app = await buildApp({ auth, webDist: config.webDist, trustProxy: config.trustProxy })
  registerRoutes(app, { auth, engine, aiRegistry, aiService, secureCookies: config.cookieSecure })
  registerMcp(app, { auth, engine, aiService })

  const secureNote = process.env.HERMODMAIL_SECRET
    ? 'HERMODMAIL_SECRET provided'
    : 'generated secret file in data dir — set HERMODMAIL_SECRET for production deployments'

  await app.listen({ port: config.port, host: config.host })
  app.log.info(`HermodMail listening on http://${config.host}:${config.port}`)
  app.log.info(`Data directory: ${config.dataDir} (${secureNote})`)
  app.log.info(`MCP endpoint: http://${config.host}:${config.port}/mcp (Authorization: Bearer hmt_…)`)

  // Populate the address book from the IMAP history already cached (runs once).
  // Non-fatal and outside the request path: contacts must never block startup.
  try {
    engine.backfillContactsOnce()
  } catch (err) {
    app.log.warn(`Contacts backfill failed (will not retry until the flag is cleared): ${String(err)}`)
  }

  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received, shutting down`)
    engine.close()
    await app.close().catch(() => {})
    db.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((err) => {
  console.error('Fatal startup error:', err)
  process.exit(1)
})

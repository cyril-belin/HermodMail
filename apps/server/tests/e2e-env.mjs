// E2E environment: real local IMAP + SMTP + production HermodMail server.
import { LocalImapServer } from './local-imap.ts'
import { LocalSmtpServer } from './local-smtp.ts'
import { makeRaw } from './inmemory-transport.ts'

const imap = new LocalImapServer()
await imap.start()
const smtp = new LocalSmtpServer()
await smtp.start()

// Seed a real mailbox: plain message, HTML message, attachment message.
const BINARY_ATTACHMENT = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xde, 0xad, 0xbe, 0xef])
imap.deliver('INBOX', makeRaw({ subject: 'Welcome to HermodMail E2E', from: 'Alice <alice@example.com>', text: 'This is the seeded plain message. Search token: xylophonedelta' }))
imap.deliver('INBOX', makeRaw({ subject: 'HTML newsletter', from: 'News <news@example.com>', html: '<h1>Big title</h1><p>Styled <b>content</b><script>alert(1)</script></p>', text: 'Styled content' }))
const b64 = BINARY_ATTACHMENT.toString('base64')
const attachRaw = Buffer.from([
  'From: Bob <bob@example.com>\r\n', 'To: me@e2e.test\r\n', 'Subject: Report with attachment\r\n',
  `Date: ${new Date().toUTCString()}\r\n`, 'Message-ID: <attach-1@example.com>\r\n', 'MIME-Version: 1.0\r\n',
  'Content-Type: multipart/mixed; boundary="AB"\r\n\r\n',
  '--AB\r\n', 'Content-Type: text/plain; charset=utf-8\r\n\r\n', 'See the binary attachment.\r\n',
  '--AB\r\n', 'Content-Type: application/octet-stream; name="blob.bin"\r\n',
  'Content-Transfer-Encoding: base64\r\n', 'Content-Disposition: attachment; filename="blob.bin"\r\n\r\n',
  b64, '\r\n--AB--\r\n',
].join(''))
imap.deliver('INBOX', attachRaw)
imap.deliver('Sent', makeRaw({ subject: 'old sent item', from: 'me@e2e.test' }), ['\\Seen'])
// Reply-To thread fixture: reply must address support@, not carol@, and must
// carry the References chain through the generated MIME.
imap.deliver('INBOX', makeRaw({
  subject: 'Need a reply-to check',
  from: 'Carol <carol@example.com>',
  text: 'Reply to the support alias please. Marker: replytofix',
  extraHeaders: {
    'Reply-To': 'Carol Support <support@example.com>',
    'References': '<root-thread@e2e.test>',
  },
}))

// Now boot the real production server (dist build).
process.env.PORT = process.env.E2E_PORT ?? '8673'
process.env.HOST = '127.0.0.1'
process.env.HERMODMAIL_DATA_DIR = process.env.E2E_DATA ?? './.e2e-data'
process.env.HERMODMAIL_WEB_DIST = '/Users/cyril/Desktop/HermodMail/apps/web/dist'
await import('../dist/index.js')

// Expose fixture ports for the driver.
console.log(JSON.stringify({ imapPort: imap.port, smtpPort: smtp.port, appPort: Number(process.env.PORT) }))
// Keep the received-mail log updated for assertions.
const fs = await import('node:fs')
setInterval(() => {
  fs.writeFileSync(process.env.E2E_SMTP_LOG ?? './.e2e-smtp-log.json', JSON.stringify(smtp.received.map((r) => ({ to: r.to, from: r.from, raw: r.raw.toString('base64') }))))
}, 500)

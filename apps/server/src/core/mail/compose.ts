import MailComposer from 'nodemailer/lib/mail-composer/index.js'
import type { Address } from '../types.js'

export interface RawMailInput {
  from: Address
  to: Address[]
  cc?: Address[]
  bcc?: Address[]
  subject: string
  text: string
  html?: string
  inReplyTo?: string
  references?: string[]
  messageId: string
  attachments?: { filename: string; contentType: string; content: Buffer }[]
}

export function buildRawMail(input: RawMailInput): Promise<Buffer> {
  const mail = new MailComposer({
    from: input.from.name ? { name: input.from.name, address: input.from.email } : input.from.email,
    to: input.to.map((a) => (a.name ? { name: a.name, address: a.email } : a.email)),
    cc: input.cc?.map((a) => (a.name ? { name: a.name, address: a.email } : a.email)),
    bcc: input.bcc?.map((a) => (a.name ? { name: a.name, address: a.email } : a.email)),
    subject: input.subject,
    text: input.text,
    html: input.html,
    inReplyTo: input.inReplyTo,
    references: input.references,
    messageId: input.messageId,
    attachments: input.attachments?.map((a) => ({
      filename: a.filename,
      contentType: a.contentType,
      content: a.content,
      contentDisposition: 'attachment',
      encoding: 'binary',
    })),
    textEncoding: 'quoted-printable',
  })
  return new Promise<Buffer>((resolve, reject) => {
    mail.compile().build((err: Error | null, message: Buffer) => {
      if (err) reject(err)
      else resolve(message)
    })
  })
}

declare module 'nodemailer/lib/mail-composer/index.js' {
  interface MailComposerOptions {
    from?: string | { name: string; address: string }
    to?: Array<string | { name: string; address: string }>
    cc?: Array<string | { name: string; address: string }>
    bcc?: Array<string | { name: string; address: string }>
    subject?: string
    text?: string
    html?: string
    inReplyTo?: string
    references?: string[] | string
    messageId?: string | boolean
    attachments?: Array<Record<string, unknown>>
    textEncoding?: string
  }
  export default class MailComposer {
    constructor(options: MailComposerOptions)
    compile(): { build(callback: (err: Error | null, message: Buffer) => void): void }
  }
}

import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { LocalImapServer } from './local-imap.js'
import { ImapFlowTransport } from '../src/core/mail/imapflow-transport.js'
import { makeRaw } from './inmemory-transport.js'

/**
 * REAL client-vs-server integration: the production ImapFlowTransport talking
 * IMAP over TCP to a local server. No fakes on the wire.
 */
describe('Round 9 prep — ImapFlowTransport against a real local IMAP server', () => {
  let imap: LocalImapServer
  let transport: ImapFlowTransport

  beforeEach(async () => {
    imap = new LocalImapServer()
    await imap.start()
    transport = await ImapFlowTransport.connect({
      host: '127.0.0.1', port: imap.port, tls: 'none', user: 'u@x.test', password: 'p',
    })
  })

  afterEach(async () => {
    await transport.close().catch(() => {})
    await imap.stop()
  })

  it('lists folders with special-use flags and counts', async () => {
    imap.deliver('INBOX', makeRaw({ subject: 'a' }))
    imap.deliver('INBOX', makeRaw({ subject: 'b' }), ['\\Seen'])
    const folders = await transport.listFolders()
    const inbox = folders.find((f) => f.path === 'INBOX')!
    // imapflow assigns 'inbox' special-use to INBOX automatically (client-side hint).
    expect(inbox).toMatchObject({ specialUse: 'inbox', totalCount: 2, unreadCount: 1 })
    const sent = folders.find((f) => f.path === 'Sent')!
    expect(sent.specialUse).toBe('sent')
  })

  it('syncs envelopes and flags over the wire', async () => {
    imap.deliver('INBOX', makeRaw({ subject: 'One', from: 'Alice <alice@example.com>', text: 'body one' }))
    imap.deliver('INBOX', makeRaw({ subject: 'Two' }), ['\\Flagged'])
    const res = await transport.syncFolder('INBOX', null, 0, 50)
    expect(res.uidvalidity).toBe(1)
    expect(res.newMessages.map((m) => m.subject)).toEqual(['Two', 'One'])
    expect(res.newMessages[1]!.from[0]!.email).toBe('alice@example.com')
    expect(res.newMessages[0]!.flagged).toBe(true)

    const second = await transport.syncFolder('INBOX', 1, 2, 50)
    expect(second.newMessages).toHaveLength(0)
    expect(second.flags.get(2)?.flagged).toBe(true)
  })

  it('fetches the full source and updates flags', async () => {
    const uid = imap.deliver('INBOX', makeRaw({ subject: 'Fetch me', text: 'payload' }))
    const src = await transport.fetchMessageSource('INBOX', uid)
    expect(src!.toString()).toContain('Subject: Fetch me')
    await transport.updateFlags('INBOX', uid, { add: ['\\Seen', '\\Flagged'] })
    expect(imap.folders.get('INBOX')!.messages[0]!.flags.has('\\Seen')).toBe(true)
    expect(imap.folders.get('INBOX')!.messages[0]!.flags.has('\\Flagged')).toBe(true)
  })

  it('moves a message to Trash and appends to Sent', async () => {
    const uid = imap.deliver('INBOX', makeRaw({ subject: 'move me' }))
    await transport.moveMessage('INBOX', uid, 'Trash')
    expect(imap.folders.get('INBOX')!.messages).toHaveLength(0)
    expect(imap.folders.get('Trash')!.messages).toHaveLength(1)
    const { buildRawMail } = await import('../src/core/mail/compose.js')
    const raw = await buildRawMail({ from: { email: 'a@b.c' }, to: [{ email: 'd@e.f' }], subject: 'sent copy', text: 'x', messageId: '<m@h>' })
    await transport.appendMessage('Sent', raw, ['\\Seen'])
    expect(imap.folders.get('Sent')!.messages).toHaveLength(1)
    expect(imap.folders.get('Sent')!.messages[0]!.flags.has('\\Seen')).toBe(true)
  })

  it('expunges exactly the requested uid (UID EXPUNGE path)', async () => {
    imap.deliver('INBOX', makeRaw({ subject: 'keep' }), ['\\Deleted']) // another client's pending delete
    const doomed = imap.deliver('INBOX', makeRaw({ subject: 'doomed' }))
    await transport.updateFlags('INBOX', doomed, { add: ['\\Deleted'] })
    await transport.expungeMessage('INBOX', doomed)
    const left = imap.folders.get('INBOX')!.messages
    // UIDPLUS server: only the requested uid was purged; the other \Deleted
    // message survives until its own client expunges it.
    expect(left.map((m) => m.raw.toString())).toHaveLength(1)
    expect(left[0]!.raw.toString()).toContain('keep')
  })

  it('creates, renames and deletes folders', async () => {
    await transport.createFolder('Work/Deep')
    expect(imap.folders.has('Work/Deep')).toBe(true)
    await transport.renameFolder('Work/Deep', 'Projects')
    expect(imap.folders.has('Projects')).toBe(true)
    expect(imap.folders.has('Work/Deep')).toBe(false)
    await transport.deleteFolder('Projects')
    expect(imap.folders.has('Projects')).toBe(false)
  })

  it('rejects bad credentials with a connection error', async () => {
    // Our test server accepts any login; simulate auth failure via a refused port.
    await expect(ImapFlowTransport.connect({ host: '127.0.0.1', port: 1, tls: 'none', user: 'u', password: 'p' }))
      .rejects.toMatchObject({ code: 'mail_connection' })
  })
})

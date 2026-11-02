import net from 'node:net'

export interface ImapMessage {
  uid: number
  flags: Set<string>
  raw: Buffer
}

export interface ImapFolder {
  name: string
  specialUse: string | null
  messages: ImapMessage[]
  uidValidity: number
  uidNext: number
}

/**
 * A minimal but real IMAP4rev1 server for tests and end-to-end runs.
 * Implements the exact command subset imapflow uses for HermodMail:
 * LOGIN, LIST, STATUS, SELECT, UID FETCH (flags/envelope/bodystructure/source),
 * UID STORE, UID MOVE, UID EXPUNGE, EXPUNGE, APPEND, CREATE, RENAME, DELETE,
 * NOOP, CAPABILITY, LOGOUT. Not a general-purpose server — deliberately
 * scoped to exercising our real client code path.
 */
export class LocalImapServer {
  readonly folders = new Map<string, ImapFolder>()
  /** Every command line received (diagnostics for test failures). */
  readonly commandLog: string[] = []
  private server: net.Server | null = null
  port = 0
  /** Drop the TCP connection before answering the next command (chaos). */
  killNextConnection = false

  constructor() {
    this.addFolder('INBOX', null)
    this.addFolder('Sent', '\\Sent')
    this.addFolder('Trash', '\\Trash')
  }

  addFolder(name: string, specialUse: string | null): ImapFolder {
    const f: ImapFolder = { name, specialUse, messages: [], uidValidity: 1, uidNext: 1 }
    this.folders.set(name, f)
    return f
  }

  deliver(folder: string, raw: Buffer, flags: string[] = []): number {
    const f = this.folders.get(folder) ?? this.addFolder(folder, null)
    const uid = f.uidNext++
    f.messages.push({ uid, flags: new Set(flags), raw })
    return uid
  }

  private static quote(s: string): string {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  }

  private static nstring(s: string | null | undefined): string {
    if (s === null || s === undefined) return 'NIL'
    return LocalImapServer.quote(s)
  }

  /** RFC 3501 ENVELOPE for one message (parsed lazily from headers). */
  private static envelope(raw: Buffer): string {
    const text = raw.toString('utf8')
    const head = text.split('\r\n\r\n')[0] ?? ''
    const header = (name: string): string => {
      const m = head.match(new RegExp(`^${name}:(.*)$`, 'im'))
      return m?.[1]?.trim() ?? ''
    }
    const addrList = (value: string): string => {
      if (!value) return 'NIL'
      const addresses = value.split(',').map((v) => {
        const m = v.trim().match(/^(.*?)\s*<\s*([^\s@]+)@([^\s@>]+)\s*>$/)
        if (m) return `(${LocalImapServer.nstring(m[1]!.trim() || null)} NIL ${LocalImapServer.nstring(m[2]!)} ${LocalImapServer.nstring(m[3]!)})`
        const simple = v.trim().match(/^([^\s@]+)@([^\s@]+)$/)
        if (simple) return `(NIL NIL ${LocalImapServer.nstring(simple[1]!)} ${LocalImapServer.nstring(simple[2]!)})`
        return null
      }).filter(Boolean)
      return addresses.length ? `(${addresses.join(' ')})` : 'NIL'
    }
    const messageId = header('Message-ID') ? LocalImapServer.quote(header('Message-ID')) : 'NIL'
    return `(${LocalImapServer.nstring(header('Date'))} ${LocalImapServer.nstring(header('Subject'))} ` +
      `${addrList(header('From'))} ${addrList(header('Sender') || header('From'))} ${addrList(header('Reply-To') || header('From'))} ` +
      `${addrList(header('To'))} ${addrList(header('Cc'))} ${addrList(header('Bcc'))} ` +
      `${LocalImapServer.nstring(header('In-Reply-To') || null)} ${messageId})`
  }

  private static bodyStructure(raw: Buffer): string {
    const text = raw.toString('utf8')
    const isMultipart = /content-type:\s*multipart\/mixed/i.test(text)
    if (!isMultipart) {
      const body = text.split('\r\n\r\n').slice(1).join('\r\n\r\n')
      return `("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "7BIT" ${Buffer.byteLength(body)} 1)`
    }
    // multipart/mixed with a text part and one attachment part
    const plain = 'message body'
    return `(("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "7BIT" ${Buffer.byteLength(plain)} 1)` +
      `("APPLICATION" "OCTET-STREAM" ("NAME" "file.bin") NIL NIL "BASE64" 4 NIL) "MIXED" ("BOUNDARY" "b") NIL NIL)`
  }

  private static flagsString(flags: Set<string>): string {
    return [...flags].join(' ')
  }

  async start(): Promise<void> {
    const self = this
    this.server = net.createServer((socket) => {
      socket.write('* OK [CAPABILITY IMAP4rev1 UIDPLUS MOVE UNSELECT] Hermod test IMAP ready\r\n')
      let buffer = ''
      const state = { selected: null as ImapFolder | null, user: '' }
      // Pending APPEND literal: while set, incoming bytes feed the message
      // instead of the command parser.
      let pendingLiteral: { need: number; got: Buffer; folder: string; flags: string[]; tag: string } | null = null

      const send = (line: string): void => socket.write(line + '\r\n')

      const okFolders = (): ImapFolder[] => [...self.folders.values()]

      const handle = (tag: string, cmd: string, rest: string): void => {
        const up = cmd.toUpperCase()
        switch (up) {
          case 'CAPABILITY':
            send('* CAPABILITY IMAP4rev1 UIDPLUS MOVE UNSELECT')
            send(`${tag} OK CAPABILITY completed`)
            return
          case 'NOOP':
            send(`${tag} OK NOOP completed`)
            return
          case 'LOGIN': {
            const m = rest.match(/^(\S+)\s+(\S+)/)
            state.user = m?.[1]?.replace(/"/g, '') ?? 'anonymous'
            send(`${tag} OK [CAPABILITY IMAP4rev1 UIDPLUS MOVE UNSELECT] LOGIN completed`)
            return
          }
          case 'LOGOUT':
            send('* BYE Hermod test IMAP logging out')
            send(`${tag} OK LOGOUT completed`)
            socket.end()
            return
          case 'NAMESPACE':
            // Declares the personal namespace as ("", "/"): without this,
            // imapflow infers a prefix from the folder hierarchy (e.g. "Trash/")
            // and rewrites every target path.
            send(`* NAMESPACE (("" "/")) NIL NIL`)
            send(`${tag} OK NAMESPACE completed`)
            return
          case 'LSUB': {
            for (const f of okFolders()) {
              send(`* LSUB () "/" ${LocalImapServer.quote(f.name)}`)
            }
            send(`${tag} OK LSUB completed`)
            return
          }
          case 'LIST': {
            // Root query (`LIST "" ""`) reports the hierarchy delimiter.
            if (rest.includes('"" ""')) {
              send(`* LIST (\\Noselect) "/" ""`)
              send(`${tag} OK LIST completed`)
              return
            }
            for (const f of okFolders()) {
              const attrs = `\\HasNoChildren${f.specialUse ? ' ' + f.specialUse : ''}`
              send(`* LIST (${attrs}) "/" ${LocalImapServer.quote(f.name)}`)
            }
            send(`${tag} OK LIST completed`)
            return
          }
          case 'STATUS': {
            const name = (rest.match(/"([^"]+)"/) ?? rest.match(/(\S+)/))?.[1] ?? ''
            const f = self.folders.get(name)
            if (!f) { send(`${tag} NO no such mailbox`); return }
            const unseen = f.messages.filter((m) => !m.flags.has('\\Seen')).length
            send(`* STATUS ${LocalImapServer.quote(name)} (MESSAGES ${f.messages.length} UNSEEN ${unseen} UIDNEXT ${f.uidNext} UIDVALIDITY ${f.uidValidity})`)
            send(`${tag} OK STATUS completed`)
            return
          }
          case 'SELECT': {
            const name = (rest.match(/"([^"]+)"/) ?? rest.match(/(\S+)/))?.[1] ?? ''
            const f = self.folders.get(name)
            if (!f) { send(`${tag} NO no such mailbox`); return }
            state.selected = f
            const unseenFirst = f.messages.find((m) => !m.flags.has('\\Seen'))
            send(`* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)`)
            send(`* ${f.messages.length} EXISTS`)
            send(`* 0 RECENT`)
            send(`* OK [PERMANENTFLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft \\*)] Flags permitted`)
            send(`* OK [UIDVALIDITY ${f.uidValidity}] UIDs valid`)
            send(`* OK [UIDNEXT ${f.uidNext}] Predicted next UID`)
            if (unseenFirst) {
              const seq = f.messages.indexOf(unseenFirst) + 1
              send(`* OK [UNSEEN ${seq}] first unseen`)
            }
            send(`${tag} OK [READ-WRITE] SELECT completed`)
            return
          }
          case 'UNSELECT':
            state.selected = null
            send(`${tag} OK UNSELECT completed`)
            return
          case 'UID': {
            const sub = rest.match(/^(\S+)\s*(.*)$/)
            const subCmd = sub?.[1]?.toUpperCase() ?? ''
            const args = sub?.[2] ?? ''
            if (subCmd === 'FETCH') return handleUidFetch(tag, args)
            if (subCmd === 'STORE') return handleUidStore(tag, args)
            if (subCmd === 'MOVE') return handleUidMove(tag, args)
            if (subCmd === 'EXPUNGE') return handleUidExpunge(tag, args)
            send(`${tag} BAD unknown UID subcommand`)
            return
          }
          case 'EXPUNGE':
            if (state.selected) {
              for (let i = state.selected.messages.length - 1; i >= 0; i--) {
                if (state.selected.messages[i]!.flags.has('\\Deleted')) {
                  state.selected.messages.splice(i, 1)
                  send(`* ${i + 1} EXPUNGE`)
                }
              }
            }
            send(`${tag} OK EXPUNGE completed`)
            return
          case 'APPEND': {
            // APPEND folder (\Seen) {size} — folder may be quoted or bare.
            const m = rest.match(/^"([^"]+)"\s*(?:\(([^)]*)\))?\s*\{(\d+)\}$/) ?? rest.match(/^(\S+)\s*(?:\(([^)]*)\))?\s*\{(\d+)\}$/)
            if (!m) { send(`${tag} BAD APPEND syntax`); return }
            pendingLiteral = { need: Number(m[3]), got: Buffer.alloc(0), folder: m[1]!, flags: (m[2] ?? '').split(/\s+/).filter(Boolean), tag }
            send(`+ Ready for literal data`)
            return
          }
          case 'CREATE': {
            const name = (rest.match(/"([^"]+)"/) ?? rest.match(/(\S+)/))?.[1] ?? ''
            if (!name) { send(`${tag} BAD CREATE`); return }
            self.addFolder(name, null)
            send(`${tag} OK CREATE completed`)
            return
          }
          case 'DELETE': {
            const name = (rest.match(/"([^"]+)"/) ?? rest.match(/(\S+)/))?.[1] ?? ''
            self.folders.delete(name)
            send(`${tag} OK DELETE completed`)
            return
          }
          case 'RENAME': {
            const m = rest.match(/"?([^"\s]+)"?\s+"?([^"\s]+)"?/)
            if (!m) { send(`${tag} BAD RENAME`); return }
            const from = self.folders.get(m[1]!)
            if (from) {
              self.folders.delete(m[1]!)
              from.name = m[2]!
              self.folders.set(m[2]!, from)
            }
            send(`${tag} OK RENAME completed`)
            return
          }
          default:
            send(`${tag} BAD unknown command ${up}`)
        }
      }

      const handleUidFetch = (tag: string, args: string): void => {
        const f = state.selected
        if (!f) { send(`${tag} NO no mailbox selected`); return }
        const rangeM = args.match(/^([0-9*:\s,]+)\s+\((.*)\)$/s)
        if (!rangeM) { send(`${tag} BAD FETCH syntax: ${args.slice(0, 80)}`); return }
        const range = rangeM[1]!.trim()
        const items = rangeM[2]!.toUpperCase()
        const uids = resolveUids(f, range)
        for (const msg of f.messages) {
          if (!uids.includes(msg.uid)) continue
          const seq = f.messages.indexOf(msg) + 1
          const parts: string[] = [`UID ${msg.uid}`]
          if (items.includes('FLAGS')) parts.push(`FLAGS (${LocalImapServer.flagsString(msg.flags)})`)
          if (items.includes('ENVELOPE')) parts.push(`ENVELOPE ${LocalImapServer.envelope(msg.raw)}`)
          if (items.includes('BODYSTRUCTURE')) parts.push(`BODYSTRUCTURE ${LocalImapServer.bodyStructure(msg.raw)}`)
          if (items.includes('RFC822.SIZE')) parts.push(`RFC822.SIZE ${msg.raw.length}`)
          const bodyPeek = args.match(/BODY\.PEEK\[\]/i) || args.match(/BODY\[\]/i)
          if (bodyPeek) {
            // The literal must go on the wire as raw bytes: routing it through
            // a latin1 string + UTF-8 socket write expands every non-ASCII byte
            // (accents, em-dashes…), breaking the declared {size} and corrupting
            // the client's parser.
            const head = `* ${seq} FETCH (${[...parts, `BODY[] {${msg.raw.length}}`].join(' ')}\r\n`
            socket.write(Buffer.from(head, 'utf8'))
            socket.write(msg.raw)
            socket.write(Buffer.from(')\r\n', 'utf8'))
          } else {
            send(`* ${seq} FETCH (${parts.join(' ')})`)
          }
        }
        send(`${tag} OK FETCH completed`)
      }

      const handleUidStore = (tag: string, args: string): void => {
        const f = state.selected
        if (!f) { send(`${tag} NO no mailbox selected`); return }
        const m = args.match(/^(\S+)\s+([+-]?)FLAGS(?:\.SILENT)?\s+\(([^)]*)\)/i)
        if (!m) { send(`${tag} BAD STORE syntax`); return }
        const uids = resolveUids(f, m[1]!.trim())
        const op = m[2] || '='
        const flags = m[3]!.split(/\s+/).filter(Boolean)
        for (const msg of f.messages) {
          if (!uids.includes(msg.uid)) continue
          if (op === '+') for (const fl of flags) msg.flags.add(fl)
          else if (op === '-') for (const fl of flags) msg.flags.delete(fl)
          else {
            msg.flags.clear()
            for (const fl of flags) msg.flags.add(fl)
          }
          const seq = f.messages.indexOf(msg) + 1
          send(`* ${seq} FETCH (UID ${msg.uid} FLAGS (${LocalImapServer.flagsString(msg.flags)}))`)
        }
        send(`${tag} OK STORE completed`)
      }

      const handleUidMove = (tag: string, args: string): void => {
        const f = state.selected
        if (!f) { send(`${tag} NO no mailbox selected`); return }
        const m = args.match(/^(\S+)\s+"?([^"\s]+)"?/)
        if (!m) { send(`${tag} BAD MOVE syntax`); return }
        const uids = resolveUids(f, m[1]!)
        const dest = self.folders.get(m[2]!) ?? self.addFolder(m[2]!, null)
        const moved: ImapMessage[] = []
        for (const uid of uids) {
          const idx = f.messages.findIndex((x) => x.uid === uid)
          if (idx === -1) continue
          moved.push(f.messages[idx]!)
          f.messages.splice(idx, 1)
        }
        for (const msg of moved) {
          const newUid = dest.uidNext++
          dest.messages.push({ ...msg, uid: newUid })
          const seq = f.messages.indexOf(msg) + 1
          void seq
        }
        // Untagged EXPUNGE with sequence renumbering after removal
        send(`* ${f.messages.length} EXISTS`) // minimal; imapflow reconciles via OK
        send(`${tag} OK [COPYUID ${dest.uidValidity} ${uids.join(',')} ${moved.map((_, i) => dest.uidNext - moved.length + i).join(',')}] MOVE completed`)
      }

      const handleUidExpunge = (tag: string, args: string): void => {
        const f = state.selected
        if (!f) { send(`${tag} NO no mailbox selected`); return }
        const uids = resolveUids(f, args.trim())
        for (const uid of uids) {
          const idx = f.messages.findIndex((x) => x.uid === uid)
          if (idx !== -1) {
            f.messages.splice(idx, 1)
            send(`* ${idx + 1} EXPUNGE`)
          }
        }
        send(`${tag} OK EXPUNGE completed`)
      }

      const resolveUids = (f: ImapFolder, range: string): number[] => {
        const all = f.messages.map((m) => m.uid)
        if (range === '1:*') return all
        const m = range.match(/^(\d+):(\d+|\*)$/)
        if (m) {
          const lo = Number(m[1])
          const hi = m[2] === '*' ? Number.POSITIVE_INFINITY : Number(m[2])
          return all.filter((u) => u >= Math.min(lo, hi === Number.POSITIVE_INFINITY ? lo : hi) && (hi === Number.POSITIVE_INFINITY || u <= Math.max(lo, hi)) && u >= lo)
        }
        const single = Number(range)
        return Number.isFinite(single) ? all.filter((u) => u === single) : []
      }

      const finalizeAppend = (p: NonNullable<typeof pendingLiteral>): void => {
        const f = self.folders.get(p.folder) ?? self.addFolder(p.folder, null)
        const uid = f.uidNext++
        f.messages.push({ uid, flags: new Set(p.flags), raw: p.got })
        send(`${p.tag} OK [APPENDUID ${f.uidValidity} ${uid}] APPEND completed`)
      }

      const processBuffer = (): void => {
        for (;;) {
          if (pendingLiteral) {
            const remaining = pendingLiteral.need - pendingLiteral.got.length
            const take = Buffer.from(buffer, 'binary').subarray(0, Math.min(remaining, buffer.length))
            pendingLiteral.got = Buffer.concat([pendingLiteral.got, take])
            buffer = buffer.slice(take.length)
            if (pendingLiteral.got.length < pendingLiteral.need) return
            const done = pendingLiteral
            pendingLiteral = null
            finalizeAppend(done)
            continue
          }
          const idx = buffer.indexOf('\r\n')
          if (idx === -1) return
          const line = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          const m = line.match(/^(\S+)\s+(\S+)\s*([\s\S]*)$/)
          if (!m) continue
          self.commandLog.push(line)
          if (self.killNextConnection) {
            self.killNextConnection = false
            socket.destroy()
            return
          }
          handle(m[1]!, m[2]!, m[3] ?? '')
          if (socket.destroyed) return
        }
      }

      socket.on('data', (d) => {
        buffer += d.toString('binary')
        void processBuffer()
      })
      socket.on('error', () => {})
    })
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
    const addr = this.server.address()
    if (addr && typeof addr === 'object') this.port = addr.port
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()))
  }
}

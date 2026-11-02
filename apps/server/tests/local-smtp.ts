import { SMTPServer } from 'smtp-server'

export interface ReceivedMail {
  from: string
  to: string[]
  raw: Buffer
}

export interface SmtpFault {
  /** Close the TCP socket right after DATA is fully received (uncertain outcome). */
  closeAfterData?: boolean
  /** Close the socket mid-DATA (truncated transmission). */
  closeMidData?: boolean
  /** Reject at a specific phase with an SMTP code. */
  rejectAt?: 'mailfrom' | 'rcpt' | 'data' | 'dataend' | 'quit'
  rejectCode?: number
  /** Delay every response by ms (slow server). */
  delayMs?: number
}

/**
 * A real local SMTP server (nodemailer's smtp-server) used for integration,
 * chaos and end-to-end tests. Records every accepted message verbatim and
 * supports deterministic fault injection at every protocol phase.
 */
export class LocalSmtpServer {
  readonly received: ReceivedMail[] = []
  fault: SmtpFault | null = null
  private server: SMTPServer | null = null
  private sockets = new Set<import('node:net').Socket>()
  port = 0

  /** Hard-reset the most recent client socket (simulates TCP RST / outage). */
  private hardClose(): void {
    // Track raw connections at the net.Server level: smtp-server's onData
    // `session` is a plain snapshot without the socket.
    const last = [...this.sockets].at(-1)
    if (last && typeof (last as { resetAndDestroy?: () => void }).resetAndDestroy === 'function') {
      ;(last as unknown as { resetAndDestroy: () => void }).resetAndDestroy()
    } else {
      last?.destroy()
    }
  }

  async start(): Promise<void> {
    const self = this
    this.server = new SMTPServer({
      authOptional: true,
      disabledCommands: ['STARTTLS'],
      // Accept any credentials: this fixture exists to exercise protocol
      // behaviour, not auth policy.
      onAuth(auth, _session, callback) {
        callback(null, { user: auth.username ?? 'test-user' })
      },
      onRcptTo(stream, session, callback) {
        if (self.fault?.rejectAt === 'rcpt') {
          callback(new Error(`${self.fault.rejectCode ?? 550} rejected by fault injection`))
          return
        }
        callback()
      },
      onMailFrom(stream, session, callback) {
        if (self.fault?.rejectAt === 'mailfrom') {
          callback(new Error(`${self.fault.rejectCode ?? 550} rejected by fault injection`))
          return
        }
        callback()
      },
      onData(stream, session, callback) {
        const chunks: Buffer[] = []
        let aborted = false
        stream.on('data', (c: Buffer) => {
          if (!aborted && self.fault?.closeMidData) {
            aborted = true
            // Hard TCP close mid-transmission: NO SMTP response at all, the
            // client sees a dead socket exactly like a real network failure.
            self.hardClose()
            return
          }
          chunks.push(c)
        })
        stream.on('error', () => {}) // socket died; handled via connection close
        stream.on('end', () => {
          if (aborted) return
          if (self.fault?.rejectAt === 'data') {
            callback(new Error(`${self.fault.rejectCode ?? 451} rejected by fault injection`))
            return
          }
          self.received.push({
            from: session.envelope.mailFrom?.address ?? '',
            to: session.envelope.rcptTo.map((r) => r.address),
            raw: Buffer.concat(chunks),
          })
          if (self.fault?.closeAfterData) {
            aborted = true
            // Data fully received server-side, but reset WITHOUT the 250
            // reply: from the client's perspective the outcome is UNDETERMINED.
            self.hardClose()
            return
          }
          callback()
        })
      },
      onQuit(_stream, _session, callback) {
        if (self.fault?.rejectAt === 'quit') {
          callback(new Error('421 bye'))
          return
        }
        callback()
      },
    })
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
    // Track raw client connections for hard resets (RST).
    this.server!.server.on('connection', (sock) => {
      this.sockets.add(sock)
      sock.on('close', () => this.sockets.delete(sock))
    })
    // smtp-server wraps the net.Server in `.server`
    const addr = this.server!.server.address()
    if (addr && typeof addr === 'object') this.port = addr.port
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()))
  }
}

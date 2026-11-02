import nodemailer from 'nodemailer'
import { AppError } from '../errors.js'
import type { SmtpSender } from './transport.js'

/**
 * Classify an SMTP failure.
 *
 * SMTP has no transactional outcome: once the message DATA has been
 * transmitted, a dropped connection or timeout leaves the delivery state
 * UNKNOWN — the server may have accepted and queued the message. Only an
 * explicit 4xx/5xx reply is a definitive protocol answer. We never auto-retry
 * a send (that is how duplicate mails are born); callers get the outcome
 * class and an explicit user-facing warning when the result is uncertain.
 *
 * Outcome classes:
 * - 'rejected'  : definitive 5xx — the server refused the message permanently.
 * - 'tempfail'  : definitive 4xx — the message was NOT accepted; a manual
 *                 retry later is safe (no duplicate risk).
 * - 'uncertain' : connection died before/after the reply — delivery state
 *                 UNKNOWN; retrying may duplicate the message.
 */
export type SmtpOutcome = 'rejected' | 'tempfail' | 'uncertain'

export function classifySmtpFailure(err: unknown): { outcome: SmtpOutcome; reason: string } {
  const e = err as { response?: string; code?: string; command?: string }
  if (typeof e?.response === 'string') {
    if (/^5\d\d[- ]/.test(e.response)) {
      return { outcome: 'rejected', reason: `SMTP server rejected the message: ${e.response}` }
    }
    if (/^4\d\d[- ]/.test(e.response)) {
      return {
        outcome: 'tempfail',
        reason:
          `SMTP server temporarily refused the message: ${e.response}. ` +
          'The message was NOT delivered; retrying later is safe (no duplicate risk).',
      }
    }
  }
  const phase = e?.command ? ` during/after ${e.command.toUpperCase()}` : ''
  return {
    outcome: 'uncertain',
    reason:
      `SMTP send failed${phase} (${e?.code ?? 'error'}). ` +
      'The delivery outcome is UNDETERMINED: if the message data was already transmitted, the server may still have accepted it. ' +
      'Do NOT blindly resend — check the recipient inbox or the Sent folder first to avoid duplicates.',
  }
}

/** Production SmtpSender backed by nodemailer, sending a pre-built raw MIME message. */
export const nodemailerSender: SmtpSender = async (smtp, raw, envelope, messageId) => {
  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.tls === 'tls',
    auth: smtp.user ? { user: smtp.user, pass: smtp.password } : undefined,
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
  })
  try {
    const info = await transporter.sendMail({
      raw,
      envelope: { from: envelope.from, to: envelope.to },
    })
    return {
      messageId: String(info.messageId ?? messageId),
      accepted: (info.accepted ?? []).map((a) => (typeof a === 'string' ? a : a.address)),
      rejected: (info.rejected ?? []).map((a) => (typeof a === 'string' ? a : a.address)),
    }
  } catch (err) {
    const { outcome, reason } = classifySmtpFailure(err)
    throw new AppError(outcome === 'rejected' || outcome === 'tempfail' ? 'mail_protocol' : 'mail_connection', reason, { outcome })
  } finally {
    transporter.close()
  }
}

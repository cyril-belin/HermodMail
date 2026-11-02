export type AppErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'mail_connection'
  | 'mail_protocol'
  | 'ai_unavailable'
  | 'internal'

const STATUS: Record<AppErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  mail_connection: 502,
  mail_protocol: 502,
  ai_unavailable: 503,
  internal: 500,
}

export class AppError extends Error {
  readonly code: AppErrorCode
  readonly status: number
  readonly details?: unknown

  constructor(code: AppErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.status = STATUS[code]
    this.details = details
  }
}

export const badRequest = (msg: string, details?: unknown) => new AppError('bad_request', msg, details)
export const unauthorized = (msg = 'Authentication required') => new AppError('unauthorized', msg)
export const forbidden = (msg = 'Permission denied') => new AppError('forbidden', msg)
export const notFound = (msg = 'Not found') => new AppError('not_found', msg)
export const conflict = (msg: string) => new AppError('conflict', msg)

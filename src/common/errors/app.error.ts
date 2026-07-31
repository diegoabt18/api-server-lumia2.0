export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code?: string,
    public readonly details?: unknown,
  ) {
    super(message)
    this.name = 'AppError'
  }

  static badRequest(message: string, details?: unknown) {
    return new AppError(400, message, 'BAD_REQUEST', details)
  }

  static unauthorized(message = 'Unauthorized', code = 'UNAUTHORIZED') {
    return new AppError(401, message, code)
  }

  static forbidden(message = 'Forbidden') {
    return new AppError(403, message, 'FORBIDDEN')
  }

  static notFound(message = 'Not found') {
    return new AppError(404, message, 'NOT_FOUND')
  }

  static conflict(message: string) {
    return new AppError(409, message, 'CONFLICT')
  }

  static tooMany(message = 'Too many requests') {
    return new AppError(429, message, 'RATE_LIMIT')
  }

  static internal(message = 'Internal server error') {
    return new AppError(500, message, 'INTERNAL_ERROR')
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError
}

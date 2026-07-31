import { AppError } from '../../../common/errors/app.error.js'
import type { SessionRepository } from '../../identity/infrastructure/session.repository.js'

export class AdminSessionService {
  constructor(private readonly sessions: SessionRepository) {}

  sessionStatus(userId: string) {
    return { ok: true, userId, at: new Date().toISOString() }
  }

  async revokeSession(currentSessionId: string, sessionId: string) {
    if (sessionId === currentSessionId) {
      throw AppError.badRequest('No puedes revocar la sesión actual desde este endpoint')
    }
    const ok = await this.sessions.revokeSessionAsAdmin(sessionId)
    if (!ok) throw AppError.notFound('Sesión no encontrada')
    return { ok: true }
  }
}

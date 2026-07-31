import type { FastifyReply, FastifyRequest } from 'fastify'
import { AppError } from '../../../common/errors/app.error.js'
import {
  hasPermission,
  resolvePermissionsForRole,
  type PermissionId,
  type UserRole,
} from '../../../common/permissions/registry.js'
import type { AccessTokenPayload } from '../domain/session.entity.js'
import { JwtTokenService } from '../infrastructure/jwt.service.js'
import { SessionRepository } from '../infrastructure/session.repository.js'
import type { AuthorizationService } from '../../security/services/authorization.service.js'

export type AuthenticatedRequest = FastifyRequest & {
  auth: AccessTokenPayload
  permissionKeys: PermissionId[]
}

const jwtService = new JwtTokenService()

export async function resolveAuth(
  request: FastifyRequest,
  sessions: SessionRepository,
  authorization?: AuthorizationService,
): Promise<{ payload: AccessTokenPayload; permissionKeys: PermissionId[] } | null> {
  const authHeader = request.headers.authorization
  const bearer = authHeader?.replace(/^Bearer\s+/i, '')
  const cookieToken = request.cookies[request.server.config.env.COOKIE_ACCESS_NAME]
  const token = bearer || cookieToken
  if (!token) return null

  const payload = jwtService.verifyAccess(token)
  if (!payload) return null

  const session = await sessions.findByIdSafe(payload.sessionId)
  if (
    !session ||
    session.revokedAt ||
    session.isActive === false ||
    !session.refreshTokenHash ||
    session.userId !== payload.userId ||
    session.expiresAt.getTime() <= Date.now()
  ) {
    return null
  }

  const sessionV = session.permissionsVersion ?? 1
  const jwtV = payload.permissionsVersion ?? 1
  if (sessionV !== jwtV) {
    throw AppError.unauthorized('Stale authorization', 'STALE_AUTHORIZATION')
  }

  const permissionKeys = authorization
    ? await authorization.resolveEffectivePermissions(payload.userId, payload.role as UserRole)
    : resolvePermissionsForRole(payload.role as UserRole)

  const LAST_USED_THROTTLE_MS = 5 * 60 * 1000
  if (Date.now() - session.lastUsedAt.getTime() > LAST_USED_THROTTLE_MS) {
    void sessions.updateLastUsed(payload.sessionId).catch(() => {})
  }

  return { payload, permissionKeys }
}

export function requireAuth(sessions: SessionRepository, authorization?: AuthorizationService) {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    const resolved = await resolveAuth(request, sessions, authorization)
    if (!resolved) throw AppError.unauthorized()
    ;(request as AuthenticatedRequest).auth = resolved.payload
    ;(request as AuthenticatedRequest).permissionKeys = resolved.permissionKeys
  }
}

export function requirePermission(permission: PermissionId) {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    const req = request as AuthenticatedRequest
    if (!req.permissionKeys || !hasPermission(req.permissionKeys, permission)) {
      throw AppError.forbidden('Insufficient permissions')
    }
  }
}

export function optionalAuth(sessions: SessionRepository, authorization?: AuthorizationService) {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    const resolved = await resolveAuth(request, sessions, authorization)
    if (resolved) {
      ;(request as AuthenticatedRequest).auth = resolved.payload
      ;(request as AuthenticatedRequest).permissionKeys = resolved.permissionKeys
    }
  }
}

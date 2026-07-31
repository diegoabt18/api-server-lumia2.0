import type { FastifyReply, FastifyRequest } from 'fastify'
import {
  hasPermission,
  PERMISSION_REGISTRY,
  type PermissionId,
} from '../../../common/permissions/registry.js'
import { AppError } from '../../../common/errors/app.error.js'
import type { SessionRepository } from '../../identity/infrastructure/session.repository.js'
import {
  requireAuth,
  type AuthenticatedRequest,
} from '../../identity/middleware/auth.middleware.js'

import type { AuthorizationService } from '../../security/services/authorization.service.js'

export function adminGuard(
  sessions: SessionRepository,
  permission: PermissionId,
  authorization?: AuthorizationService,
) {
  const auth = requireAuth(sessions, authorization)
  return async (request: FastifyRequest, reply: FastifyReply) => {
    await auth(request, reply)
    const req = request as AuthenticatedRequest
    if (!hasPermission(req.permissionKeys, PERMISSION_REGISTRY.ADMIN_ACCESS)) {
      throw AppError.forbidden('Admin access required')
    }
    if (!hasPermission(req.permissionKeys, permission)) {
      throw AppError.forbidden('Insufficient permissions')
    }
  }
}

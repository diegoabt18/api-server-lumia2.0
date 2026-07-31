import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../app.context.js'
import { AppError } from '../common/errors/app.error.js'
import { PERMISSION_REGISTRY } from '../common/permissions/registry.js'
import { adminGuard } from '../modules/admin/middleware/admin-guard.js'
import type { AuthenticatedRequest } from '../modules/identity/middleware/auth.middleware.js'
import {
  assignRoleSchema,
  roleCreateSchema,
  rolePatchSchema,
  twoFactorCodeSchema,
  twoFactorVerifyLoginSchema,
} from '../modules/security/schemas/security.schema.js'
import { registerSecurityExtendedRoutes } from './security-extended.routes.js'
import {
  setAuthCookies,
} from '../modules/identity/utils/cookie.utils.js'
import { getClientContext } from '../common/utils/request.utils.js'

export async function registerSecurityRoutes(api: FastifyInstance, ctx: AppContext) {
  const { services, repos } = ctx
  const { requireAuth } = await import('../modules/identity/middleware/auth.middleware.js')
  const authGuard = requireAuth(repos.sessions, services.authorization)

  const g = (permission: (typeof PERMISSION_REGISTRY)[keyof typeof PERMISSION_REGISTRY]) =>
    adminGuard(repos.sessions, permission, services.authorization)

  // ─── 2FA ───
  api.post('/auth/2fa/setup', {
    preHandler: authGuard,
    schema: { tags: ['auth', '2fa'], summary: 'Iniciar setup 2FA (admin)' },
  }, async (request) => {
    const auth = (request as AuthenticatedRequest).auth
    if (auth.role !== 'admin') throw AppError.forbidden('Solo administradores pueden activar 2FA')
    return services.twoFactor.setup(auth.userId)
  })

  api.post('/auth/2fa/confirm', {
    preHandler: authGuard,
    schema: { tags: ['auth', '2fa'], summary: 'Confirmar setup 2FA' },
  }, async (request) => {
    const parsed = twoFactorCodeSchema.safeParse(request.body)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    const auth = (request as AuthenticatedRequest).auth
    return services.twoFactor.confirmSetup(auth.userId, parsed.data.code)
  })

  api.post('/auth/2fa/disable', {
    preHandler: authGuard,
    schema: { tags: ['auth', '2fa'], summary: 'Desactivar 2FA' },
  }, async (request) => {
    const parsed = twoFactorCodeSchema.safeParse(request.body)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    const auth = (request as AuthenticatedRequest).auth
    return services.twoFactor.disable(auth.userId, parsed.data.code)
  })

  api.post('/auth/2fa/verify', {
    schema: { tags: ['auth', '2fa'], summary: 'Verificar código 2FA tras login' },
  }, async (request, reply) => {
    const parsed = twoFactorVerifyLoginSchema.safeParse(request.body)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())

    const client = getClientContext(request)
    const result = await services.twoFactor.verifyLogin({
      tempToken: parsed.data.tempToken,
      code: parsed.data.code,
      ip: client.ip,
      userAgent: client.userAgent,
    })

    setAuthCookies(reply, request, {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      refreshMaxAgeSeconds: result.refreshMaxAgeSeconds,
    })

    return {
      user: result.user,
      permHash: result.permHash,
      permissionsVersion: result.permissionsVersion,
      accessExpiresAt: result.accessExpiresAtMs,
    }
  })

  // ─── RBAC admin ───
  api.get('/admin/security/roles', { preHandler: g(PERMISSION_REGISTRY.ADMIN_ROLES_READ) }, async () =>
    services.securityAdmin.listRoles(),
  )

  api.post('/admin/security/roles', { preHandler: g(PERMISSION_REGISTRY.ADMIN_ROLES_MANAGE) }, async (request) => {
    const parsed = roleCreateSchema.safeParse(request.body)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    return services.securityAdmin.createRole(parsed.data)
  })

  api.get('/admin/security/roles/:id', { preHandler: g(PERMISSION_REGISTRY.ADMIN_ROLES_READ) }, async (request) => {
    const { id } = request.params as { id: string }
    return services.securityAdmin.getRole(id)
  })

  api.patch('/admin/security/roles/:id', { preHandler: g(PERMISSION_REGISTRY.ADMIN_ROLES_MANAGE) }, async (request) => {
    const { id } = request.params as { id: string }
    const parsed = rolePatchSchema.safeParse(request.body)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    return services.securityAdmin.updateRole(id, parsed.data)
  })

  api.delete('/admin/security/roles/:id', { preHandler: g(PERMISSION_REGISTRY.ADMIN_ROLES_MANAGE) }, async (request) => {
    const { id } = request.params as { id: string }
    return services.securityAdmin.deleteRole(id)
  })

  api.get('/admin/security/permissions', { preHandler: g(PERMISSION_REGISTRY.ADMIN_PERMISSIONS_READ) }, async () =>
    services.securityAdmin.listPermissions(),
  )

  api.get('/admin/security/users', { preHandler: g(PERMISSION_REGISTRY.ADMIN_USERS_READ) }, async (request) =>
    services.securityAdmin.listUsers(request.query as Record<string, unknown>),
  )

  api.get('/admin/security/users/:id', { preHandler: g(PERMISSION_REGISTRY.ADMIN_USERS_READ) }, async (request) => {
    const { id } = request.params as { id: string }
    return services.securityAdmin.getUser(id)
  })

  api.post('/admin/security/users/:id/roles', { preHandler: g(PERMISSION_REGISTRY.ADMIN_USERS_MANAGE) }, async (request) => {
    const { id } = request.params as { id: string }
    const parsed = assignRoleSchema.safeParse(request.body)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    const auth = (request as AuthenticatedRequest).auth
    return services.securityAdmin.assignRole(id, parsed.data.roleId, auth.userId)
  })

  api.delete('/admin/security/users/:id/roles/:roleId', { preHandler: g(PERMISSION_REGISTRY.ADMIN_USERS_MANAGE) }, async (request) => {
    const { id, roleId } = request.params as { id: string; roleId: string }
    return services.securityAdmin.removeRole(id, roleId)
  })

  // ─── Legacy aliases ───
  api.get('/admin/roles', { preHandler: g(PERMISSION_REGISTRY.ADMIN_ROLES_READ) }, async () =>
    services.securityAdmin.listRoles(),
  )
  api.post('/admin/roles', { preHandler: g(PERMISSION_REGISTRY.ADMIN_ROLES_MANAGE) }, async (request) => {
    const parsed = roleCreateSchema.safeParse(request.body)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    return services.securityAdmin.createRole(parsed.data)
  })
  api.get('/admin/roles/:id', { preHandler: g(PERMISSION_REGISTRY.ADMIN_ROLES_READ) }, async (request) => {
    const { id } = request.params as { id: string }
    return services.securityAdmin.getRole(id)
  })
  api.patch('/admin/roles/:id', { preHandler: g(PERMISSION_REGISTRY.ADMIN_ROLES_MANAGE) }, async (request) => {
    const { id } = request.params as { id: string }
    const parsed = rolePatchSchema.safeParse(request.body)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    return services.securityAdmin.updateRole(id, parsed.data)
  })
  api.delete('/admin/roles/:id', { preHandler: g(PERMISSION_REGISTRY.ADMIN_ROLES_MANAGE) }, async (request) => {
    const { id } = request.params as { id: string }
    return services.securityAdmin.deleteRole(id)
  })
  api.get('/admin/permissions', { preHandler: g(PERMISSION_REGISTRY.ADMIN_PERMISSIONS_READ) }, async () =>
    services.securityAdmin.listPermissions(),
  )

  await registerSecurityExtendedRoutes(api, ctx)
}

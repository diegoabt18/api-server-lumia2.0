import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../app.context.js'
import { AppError } from '../common/errors/app.error.js'
import {
  accountPreferencesPatchSchema,
  markNotificationsReadSchema,
  profilePatchSchema,
  registerSchema,
  revokeSessionSchema,
} from '../modules/identity/schemas/account.schema.js'
import type { AuthenticatedRequest } from '../modules/identity/middleware/auth.middleware.js'
import type { UserRole } from '../common/permissions/registry.js'
import {
  setAuthCookies,
  clearAuthCookies,
  getRefreshTokenFromRequest,
} from '../modules/identity/utils/cookie.utils.js'
import { getClientContext } from '../common/utils/request.utils.js'

export async function registerStorePublicRoutes(api: FastifyInstance, ctx: AppContext) {
  const { services, repos } = ctx
  const { requireAuth } = await import('../modules/identity/middleware/auth.middleware.js')
  const authGuard = requireAuth(repos.sessions, services.authorization)

  api.get('/store/banners', async (request) => {
    const query = request.query as { positions?: string }
    return services.store.getBanners(query.positions)
  })

  api.get('/store/shipping-settings', async () => services.store.getShippingSettings())
  api.get('/store/currency-settings', async () => services.store.getCurrencySettings())
  api.get('/store/customer-settings', async () => services.store.getCustomerSettings())

  api.get('/notifications', { preHandler: authGuard }, async (request) => {
    const auth = (request as AuthenticatedRequest).auth
    const query = request.query as { page?: string; limit?: string }
    const page = Math.max(1, Number(query.page) || 1)
    const limit = Math.min(50, Math.max(1, Number(query.limit) || 20))
    return services.notifications.list(auth.userId, page, limit)
  })

  api.get('/notifications/unread-count', { preHandler: authGuard }, async (request) => {
    const auth = (request as AuthenticatedRequest).auth
    return services.notifications.unreadCount(auth.userId)
  })

  api.patch('/notifications/read', { preHandler: authGuard }, async (request) => {
    const parsed = markNotificationsReadSchema.safeParse(request.body)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    const auth = (request as AuthenticatedRequest).auth
    return services.notifications.markRead(auth.userId, parsed.data.ids)
  })

  api.patch('/notifications/read-all', { preHandler: authGuard }, async (request) => {
    const auth = (request as AuthenticatedRequest).auth
    return services.notifications.markAllRead(auth.userId)
  })

  api.delete('/notifications/:id', { preHandler: authGuard }, async (request) => {
    const { id } = request.params as { id: string }
    const auth = (request as AuthenticatedRequest).auth
    try {
      return await services.notifications.delete(auth.userId, id)
    } catch {
      throw AppError.notFound('Notification not found')
    }
  })

  api.patch('/account/preferences', { preHandler: authGuard }, async (request) => {
    const parsed = accountPreferencesPatchSchema.safeParse(request.body)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    const auth = (request as AuthenticatedRequest).auth
    return services.auth.updatePreferences(auth.userId, parsed.data)
  })
}

export async function registerAuthExtendedRoutes(api: FastifyInstance, ctx: AppContext) {
  const { services, repos } = ctx
  const { requireAuth } = await import('../modules/identity/middleware/auth.middleware.js')
  const authGuard = requireAuth(repos.sessions, services.authorization)

  api.post('/auth/register', async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())

    const client = getClientContext(request)
    const result = await services.auth.register({
      ...parsed.data,
      userAgent: client.userAgent,
      ip: client.ip,
      country: client.country,
      acceptLanguage: request.headers['accept-language'],
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
      accessExpiresAt: result.accessExpiresAt,
    }
  })

  api.get('/auth/nickname-availability', async (request) => {
    const query = request.query as { nickname?: string }
    return services.auth.checkNicknameAvailability(query.nickname ?? '')
  })

  api.patch('/auth/profile', { preHandler: authGuard }, async (request) => {
    const parsed = profilePatchSchema.safeParse(request.body)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    const auth = (request as AuthenticatedRequest).auth
    return services.auth.updateProfile(auth.userId, parsed.data)
  })

  api.get('/auth/permissions', { preHandler: authGuard }, async (request, reply) => {
    reply.header('Cache-Control', 'private, max-age=300')
    const auth = (request as AuthenticatedRequest).auth
    return services.auth.getPermissionsForUser(
      auth.userId,
      auth.role as UserRole,
      auth.permHash,
      auth.permissionsVersion,
    )
  })

  api.get('/auth/sessions', { preHandler: authGuard }, async (request) => {
    const auth = (request as AuthenticatedRequest).auth
    return services.auth.listSessions(auth.userId)
  })

  api.post('/auth/sessions/revoke', { preHandler: authGuard }, async (request) => {
    const parsed = revokeSessionSchema.safeParse(request.body)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    const auth = (request as AuthenticatedRequest).auth
    return services.auth.revokeSession(auth.userId, auth.sessionId, parsed.data.sessionId)
  })

  api.post('/auth/logout-all', { preHandler: authGuard }, async (request, reply) => {
    const body = request.body as { exceptCurrent?: boolean } | undefined
    const auth = (request as AuthenticatedRequest).auth
    const exceptCurrent = body?.exceptCurrent === true
    await services.auth.logoutAll(auth.userId, exceptCurrent, auth.sessionId)
    if (!exceptCurrent) {
      const refreshToken = getRefreshTokenFromRequest(request)
      await services.auth.logout(refreshToken)
      clearAuthCookies(reply, request)
    }
    return { ok: true }
  })
}

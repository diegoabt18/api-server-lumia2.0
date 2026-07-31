import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../app.context.js'
import { AppError } from '../common/errors/app.error.js'
import {
  cancelOrderSchema,
  cancelRequestSchema,
  manualPaymentSchema,
} from '../modules/payments/schemas/payment.schema.js'
import type { AuthenticatedRequest } from '../modules/identity/middleware/auth.middleware.js'

export async function registerPaymentRoutes(api: FastifyInstance, ctx: AppContext) {
  const { services, repos } = ctx
  const { requireAuth, optionalAuth } = await import('../modules/identity/middleware/auth.middleware.js')
  const authGuard = requireAuth(repos.sessions, services.authorization)
  const optionalAuthGuard = optionalAuth(repos.sessions, services.authorization)

  api.post('/payments/manual', { preHandler: optionalAuthGuard }, async (request, reply) => {
    const parsed = manualPaymentSchema.safeParse(request.body)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())

    const auth = (request as AuthenticatedRequest).auth
    if (auth?.userId) {
      await services.orders.getById(parsed.data.orderId, auth.userId)
    } else {
      const order = await repos.orders.findByIdSafe(parsed.data.orderId)
      if (!order) throw AppError.notFound('Orden no encontrada')
    }

    const { getGuestCartKey, clearGuestCartCookie } = await import('../common/utils/guest-cart.utils.js')
    const result = await services.manualPayments.createForOrder(parsed.data.orderId, {
      cartKey: getGuestCartKey(request),
      userId: auth?.userId ?? null,
    })
    clearGuestCartCookie(reply, request)
    return result
  })

  api.post('/orders/:id/cancel', { preHandler: authGuard }, async (request) => {
    const { id } = request.params as { id: string }
    const parsed = cancelOrderSchema.safeParse(request.body ?? {})
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    const auth = (request as AuthenticatedRequest).auth
    return services.orders.cancel(id.trim(), auth.userId, parsed.data.reason)
  })

  api.post('/orders/:id/cancel-request', { preHandler: authGuard }, async (request) => {
    const { id } = request.params as { id: string }
    const parsed = cancelRequestSchema.safeParse(request.body)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    const auth = (request as AuthenticatedRequest).auth
    return services.orders.requestCancellation(id.trim(), auth.userId, parsed.data.reason)
  })

  api.get('/orders/list', { preHandler: authGuard }, async (request) => {
    const auth = (request as AuthenticatedRequest).auth
    return services.orders.listMine(auth.userId)
  })
}

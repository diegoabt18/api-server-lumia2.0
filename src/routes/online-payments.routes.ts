import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { AppContext } from '../app.context.js'
import { AppError } from '../common/errors/app.error.js'
import type { AuthenticatedRequest } from '../modules/identity/middleware/auth.middleware.js'
import {
  MercadoPagoApiError,
  parseMercadoPagoWebhook,
  verifyMercadoPagoSignature,
} from '../modules/payments/infrastructure/mercadopago.client.js'
import { resolvePaymentMethodDisplay, type PaymentMethod } from '../modules/payments/domain/payment-method.js'
import { assertMercadoPagoEnabled, isMercadoPagoEnabled } from '../modules/payments/domain/mercadopago-gate.js'

/** Métodos que el checkout en línea puede ofrecer (el POS usa cash/bank_transfer por su cuenta). */
const ONLINE_METHOD_IDS = new Set(['mercadopago', 'manual'])

const orderIdSchema = z.object({ orderId: z.string().trim().min(1).max(64) })
const retrySchema = orderIdSchema.extend({ method: z.enum(['mercadopago', 'manual']).optional() })

export async function registerOnlinePaymentRoutes(api: FastifyInstance, ctx: AppContext) {
  const { repos, services } = ctx
  const { optionalAuth } = await import('../modules/identity/middleware/auth.middleware.js')
  const optionalAuthGuard = optionalAuth(repos.sessions, services.authorization)
  // Lectura en cada llamada: el flag viene del entorno y no debe activarse por credenciales.
  const mercadoPagoEnabled = () => isMercadoPagoEnabled(ctx.env)

  /**
   * Una orden con dueño solo la puede pagar su dueño. Las órdenes de invitado (sin dueño)
   * se identifican por su id, como en el flujo actual de Lumia.
   */
  async function assertCanPay(orderId: string, request: FastifyRequest) {
    const order = await repos.orders.findEntityById(orderId)
    if (!order) throw AppError.notFound('Orden no encontrada')
    const auth = (request as AuthenticatedRequest).auth
    if (order.userId && order.userId !== auth?.userId) throw AppError.notFound('Orden no encontrada')
    return order
  }

  api.get('/payment-methods', async () => {
    // Fuente de verdad: store_payment_settings (estado activo y textos). El código solo aporta respaldo.
    const settings = await repos.storeSettings.getPaymentSettings()
    const data = settings.methods
      .filter((method) => method.isActive && ONLINE_METHOD_IDS.has(method.methodId))
      // Mientras Mercado Pago esté apagado no se ofrece en el checkout.
      .filter((method) => method.methodId !== 'mercadopago' || mercadoPagoEnabled())
      .map((method) => {
        const display = resolvePaymentMethodDisplay(method.methodId as PaymentMethod, method)
        return {
          id: method.methodId,
          displayName: display.displayName,
          description: display.description,
          isActive: true,
          requiresRedirect: display.requiresRedirect,
          isEmbedded: false,
          estimatedProcessingTime: display.estimatedProcessingTime,
        }
      })
    return { data }
  })

  api.post('/payments/create-preference', { preHandler: optionalAuthGuard }, async (request) => {
    const parsed = orderIdSchema.safeParse(request.body ?? {})
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    assertMercadoPagoEnabled(mercadoPagoEnabled())
    await assertCanPay(parsed.data.orderId, request)
    return services.onlinePayments.createPreference(parsed.data.orderId)
  })

  api.post('/payments/retry', { preHandler: optionalAuthGuard }, async (request) => {
    const parsed = retrySchema.safeParse(request.body ?? {})
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    if ((parsed.data.method ?? 'mercadopago') === 'mercadopago') assertMercadoPagoEnabled(mercadoPagoEnabled())
    await assertCanPay(parsed.data.orderId, request)
    return services.onlinePayments.retry(parsed.data.orderId, parsed.data.method ?? 'mercadopago')
  })

  /**
   * Webhook de Mercado Pago. Responde 2xx solo cuando la notificación quedó procesada o no
   * aplica; responde 5xx ante errores transitorios para que Mercado Pago la reintente.
   */
  api.post('/mercadopago/webhook', async (request, reply) => {
    // 503 mantiene la notificación pendiente en Mercado Pago para reintento si algún día se activa.
    assertMercadoPagoEnabled(mercadoPagoEnabled())
    const parsed = parseMercadoPagoWebhook(request.body)
    if (!parsed || parsed.type !== 'payment') return reply.send({ received: true })

    const secret = ctx.env.MP_WEBHOOK_SECRET
    if (secret) {
      const valid = verifyMercadoPagoSignature({
        secret,
        signatureHeader: request.headers['x-signature'] as string | undefined,
        requestId: request.headers['x-request-id'] as string | undefined,
        dataId: parsed.paymentId,
      })
      if (!valid) return reply.code(401).send({ error: 'invalid_signature' })
    }

    try {
      const outcome = await services.onlinePayments.confirmWebhook(parsed.paymentId)
      return reply.send({ received: true, status: outcome.status })
    } catch (error) {
      request.log.error(
        { err: error instanceof MercadoPagoApiError ? error.message : 'webhook_processing_failed' },
        'mercadopago webhook failed',
      )
      return reply.code(500).send({ received: false })
    }
  })
}

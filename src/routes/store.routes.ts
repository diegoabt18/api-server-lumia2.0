import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { AppContext } from '../app.context.js'
import { AppError } from '../common/errors/app.error.js'
import {
  ensureGuestCartKey,
  getGuestCartKey,
} from '../common/utils/guest-cart.utils.js'
import { addCartItemSchema, removeCartItemSchema, updateCartItemSchema } from '../modules/sales/schemas/cart.schema.js'
import { checkoutShippingSchema } from '../modules/sales/schemas/checkout.schema.js'
import {
  answerWriteSchema,
  feedbackQuerySchema,
  questionWriteSchema,
  reactionSchema,
  reportWriteSchema,
  reviewWriteSchema,
} from '../modules/sales/schemas/feedback.schema.js'
import { createOrderSchema } from '../modules/sales/schemas/order.schema.js'
import {
  favoritesSyncSchema,
  favoritesToggleSchema,
  newsletterSubscribeSchema,
} from '../modules/sales/schemas/store.schema.js'
import type { AuthenticatedRequest } from '../modules/identity/middleware/auth.middleware.js'

function resolveCartKey(auth?: AuthenticatedRequest['auth'], guestKey?: string): string | null {
  if (auth?.userId) return auth.userId
  if (guestKey) return guestKey
  return null
}

export async function registerStoreRoutes(api: FastifyInstance, ctx: AppContext) {
  const { services, repos } = ctx
  const { requireAuth, optionalAuth } = await import('../modules/identity/middleware/auth.middleware.js')
  const authGuard = requireAuth(repos.sessions, services.authorization)
  const optionalAuthGuard = optionalAuth(repos.sessions, services.authorization)

  api.get('/auth/google', async (request, reply) => services.googleOAuth.startLogin(request, reply))
  api.get('/auth/google/callback', async (request, reply) =>
    services.googleOAuth.handleCallback(request, reply),
  )

  api.get('/cart', { preHandler: optionalAuthGuard }, async (request) => {
    const auth = (request as AuthenticatedRequest).auth
    const cartKey = resolveCartKey(auth, getGuestCartKey(request))
    if (!cartKey) return { items: [], source: 'local' as const }
    return services.cart.getCart(cartKey)
  })

  api.delete('/cart', { preHandler: optionalAuthGuard }, async (request, reply) => {
    const auth = (request as AuthenticatedRequest).auth
    const cartKey = auth?.userId ?? ensureGuestCartKey(request, reply)
    return services.cart.clear(cartKey)
  })

  api.post('/cart/items', { preHandler: optionalAuthGuard }, async (request, reply) => {
    const parsed = addCartItemSchema.safeParse(request.body)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    const auth = (request as AuthenticatedRequest).auth
    const cartKey = auth?.userId ?? ensureGuestCartKey(request, reply)
    return services.cart.addItem(cartKey, parsed.data, auth?.userId ?? null)
  })

  api.patch('/cart/items', { preHandler: optionalAuthGuard }, async (request, reply) => {
    const parsed = updateCartItemSchema.safeParse(request.body)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    const auth = (request as AuthenticatedRequest).auth
    const cartKey = auth?.userId ?? ensureGuestCartKey(request, reply)
    return services.cart.updateQuantity(cartKey, parsed.data.sku, parsed.data.quantity, auth?.userId ?? null)
  })

  api.delete('/cart/items', { preHandler: optionalAuthGuard }, async (request, reply) => {
    const parsed = removeCartItemSchema.safeParse(request.body)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    const auth = (request as AuthenticatedRequest).auth
    const cartKey = auth?.userId ?? ensureGuestCartKey(request, reply)
    return services.cart.removeItem(cartKey, parsed.data.sku, auth?.userId ?? null)
  })

  api.get('/account/favorites', { preHandler: authGuard }, async (request) => {
    const auth = (request as AuthenticatedRequest).auth
    return services.favorites.list(auth.userId)
  })

  api.post('/account/favorites/sync', { preHandler: authGuard }, async (request) => {
    const parsed = favoritesSyncSchema.safeParse(request.body)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    const auth = (request as AuthenticatedRequest).auth
    return services.favorites.sync(auth.userId, parsed.data.slugs)
  })

  api.post('/account/favorites/toggle', { preHandler: authGuard }, async (request) => {
    const parsed = favoritesToggleSchema.safeParse(request.body)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    const auth = (request as AuthenticatedRequest).auth
    return services.favorites.toggle(auth.userId, parsed.data.productSlug)
  })

  api.get('/orders/mine', { preHandler: authGuard }, async (request) => {
    const auth = (request as AuthenticatedRequest).auth
    return services.orders.listMine(auth.userId)
  })

  api.get('/orders/mine/:id', { preHandler: authGuard }, async (request) => {
    const { id } = request.params as { id: string }
    const auth = (request as AuthenticatedRequest).auth
    return services.orders.getById(id, auth.userId)
  })

  api.get('/orders/view', async (request) => {
    const query = request.query as { token?: string }
    if (!query.token?.trim()) throw AppError.badRequest('token required')
    return services.orders.getByAccessToken(query.token.trim())
  })

  api.get('/orders/by-number/:orderNumber', async (request) => {
    const { orderNumber } = request.params as { orderNumber: string }
    return services.orders.getIdByOrderNumber(orderNumber)
  })

  // Vista pública post-pago (thank-you, invitados). Solo campos no sensibles.
  api.get('/orders/public/:id', async (request) => {
    const { id } = request.params as { id: string }
    if (!id?.trim()) throw AppError.badRequest('id required')
    const order = await services.orders.getById(id.trim())
    if (!order) throw AppError.notFound('Order not found')
    return {
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      paymentStatus: order.paymentStatus,
    }
  })

  api.post('/orders/create', { preHandler: optionalAuthGuard }, async (request, reply) => {
    const checkoutParsed = checkoutShippingSchema.safeParse(request.body)
    if (checkoutParsed.success) {
      const auth = (request as AuthenticatedRequest).auth
      const cartKey = auth?.userId ?? ensureGuestCartKey(request, reply)
      let userEmail: string | null = null
      if (auth?.userId) {
        const user = await services.auth.getMe(auth.userId)
        userEmail = user.email
      }
      return services.orders.createFromCheckout(
        cartKey,
        checkoutParsed.data,
        auth?.userId ?? null,
        userEmail,
      )
    }

    const parsed = createOrderSchema.safeParse(request.body)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())

    const auth = (request as AuthenticatedRequest).auth
    if (!auth) throw AppError.unauthorized()
    const user = await services.auth.getMe(auth.userId)
    return services.orders.create(parsed.data, auth.userId, user.email)
  })

  // ─── Reseñas, preguntas y reportes de producto ───
  // Lectura pública; escritura autenticada con límites de tasa por ruta (mismos que Lumia).
  const feedbackAuthor = async (request: FastifyRequest) => {
    const auth = (request as AuthenticatedRequest).auth
    const user = await services.auth.getMe(auth.userId)
    return {
      id: auth.userId,
      name: user.nickname || user.name || `Usuario ${auth.userId.slice(-6)}`,
      avatar: user.avatar ?? '',
    }
  }
  const writeLimit = (max: number) => ({ config: { rateLimit: { max, timeWindow: 60_000 } } })

  api.get('/products/:slug/feedback', async (request) => {
    const { slug } = request.params as { slug: string }
    const parsed = feedbackQuerySchema.safeParse(request.query ?? {})
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    const q = parsed.data
    return services.feedback.list(slug, {
      reviewPage: q.reviewPage ?? q.page ?? 1,
      reviewLimit: q.reviewLimit ?? q.limit ?? 8,
      questionPage: q.questionPage ?? 1,
      questionLimit: q.questionLimit ?? 10,
      stars: q.stars,
      verifiedOnly: q.verifiedOnly === '1' || q.verifiedOnly === 'true',
      reviewSort: q.reviewSort ?? 'recent',
    })
  })

  const submitReview = async (request: FastifyRequest) => {
    const { slug } = request.params as { slug: string }
    const parsed = reviewWriteSchema.safeParse(request.body ?? {})
    if (!parsed.success) throw AppError.badRequest('Reseña inválida', parsed.error.flatten())
    return services.feedback.submitReview(slug, await feedbackAuthor(request), parsed.data)
  }
  // Alias usado por lumia2.0.
  api.post('/products/:slug/feedback', { preHandler: authGuard, ...writeLimit(5) }, submitReview)
  api.post('/products/:slug/reviews', { preHandler: authGuard, ...writeLimit(5) }, submitReview)

  api.post('/products/:slug/reviews/:reviewId/reaction', { preHandler: authGuard, ...writeLimit(40) }, async (request) => {
    const { slug, reviewId } = request.params as { slug: string; reviewId: string }
    const parsed = reactionSchema.safeParse(request.body)
    if (!parsed.success) throw AppError.badRequest('Reacción inválida', parsed.error.flatten())
    const auth = (request as AuthenticatedRequest).auth
    return services.feedback.reactToReview(slug, reviewId, auth.userId, parsed.data.reaction)
  })

  api.post('/products/:slug/questions', { preHandler: authGuard, ...writeLimit(8) }, async (request) => {
    const { slug } = request.params as { slug: string }
    const parsed = questionWriteSchema.safeParse(request.body)
    if (!parsed.success) throw AppError.badRequest('Pregunta inválida', parsed.error.flatten())
    return services.feedback.createQuestion(slug, await feedbackAuthor(request), parsed.data.body)
  })

  api.post('/products/:slug/questions/:questionId/answers', { preHandler: authGuard, ...writeLimit(12) }, async (request) => {
    const { slug, questionId } = request.params as { slug: string; questionId: string }
    const parsed = answerWriteSchema.safeParse(request.body)
    if (!parsed.success) throw AppError.badRequest('Respuesta inválida', parsed.error.flatten())
    const auth = (request as AuthenticatedRequest).auth
    return services.feedback.answerQuestion(
      slug,
      questionId,
      await feedbackAuthor(request),
      parsed.data.body,
      auth.role === 'admin',
    )
  })

  api.post('/products/:slug/questions/:questionId/reaction', { preHandler: authGuard, ...writeLimit(40) }, async (request) => {
    const { slug, questionId } = request.params as { slug: string; questionId: string }
    const parsed = reactionSchema.safeParse(request.body)
    if (!parsed.success) throw AppError.badRequest('Reacción inválida', parsed.error.flatten())
    const auth = (request as AuthenticatedRequest).auth
    return services.feedback.reactToQuestion(slug, questionId, auth.userId, parsed.data.reaction)
  })

  api.post('/products/:slug/report', { preHandler: authGuard, ...writeLimit(10) }, async (request) => {
    const parsed = reportWriteSchema.safeParse(request.body)
    if (!parsed.success) throw AppError.badRequest('Reporte inválido', parsed.error.flatten())
    const auth = (request as AuthenticatedRequest).auth
    return services.feedback.report(auth.userId, parsed.data)
  })

  api.post('/newsletter/subscribe', async (request) => {
    const parsed = newsletterSubscribeSchema.safeParse(request.body)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    return services.newsletter.subscribe(parsed.data.email)
  })
}

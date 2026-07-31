import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../app.context.js'
import { AppError } from '../common/errors/app.error.js'
import {
  ensureGuestCartKey,
  getGuestCartKey,
} from '../common/utils/guest-cart.utils.js'
import { addCartItemSchema, removeCartItemSchema, updateCartItemSchema } from '../modules/sales/schemas/cart.schema.js'
import { checkoutShippingSchema } from '../modules/sales/schemas/checkout.schema.js'
import { createOrderSchema } from '../modules/sales/schemas/order.schema.js'
import {
  favoritesSyncSchema,
  favoritesToggleSchema,
  newsletterSubscribeSchema,
  submitReviewSchema,
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

  api.get('/products/:slug/feedback', async (request) => {
    const { slug } = request.params as { slug: string }
    const query = request.query as { page?: string; limit?: string }
    const page = Math.max(1, Number(query.page) || 1)
    const limit = Math.min(20, Math.max(1, Number(query.limit) || 8))
    return services.feedback.list(slug, page, limit)
  })

  api.post('/products/:slug/feedback', { preHandler: authGuard }, async (request) => {
    const { slug } = request.params as { slug: string }
    const parsed = submitReviewSchema.safeParse(request.body)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    const auth = (request as AuthenticatedRequest).auth
    const user = await services.auth.getMe(auth.userId)
    return services.feedback.submit(slug, auth.userId, user.nickname ?? user.email, parsed.data)
  })

  api.post('/newsletter/subscribe', async (request) => {
    const parsed = newsletterSubscribeSchema.safeParse(request.body)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    return services.newsletter.subscribe(parsed.data.email)
  })
}

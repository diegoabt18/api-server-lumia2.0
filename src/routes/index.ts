import type { FastifyInstance } from 'fastify'
import { isAppError } from '../common/errors/app.error.js'
import { getProductionModuleStatus } from '../modules/production/index.js'
import { registerStoreRoutes } from './store.routes.js'
import { registerPaymentRoutes } from './payments.routes.js'
import { registerStorePublicRoutes, registerAuthExtendedRoutes } from './store-public.routes.js'
import { registerAdminRoutes } from './admin.routes.js'
import { registerProductionAdminRoutes } from './production-admin.routes.js'
import { registerProductionPublicRoutes } from './production-public.routes.js'
import { registerSecurityRoutes } from './security.routes.js'

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((error, request, reply) => {
    if (isAppError(error)) {
      return reply.status(error.statusCode).send({
        error: true,
        message: error.message,
        code: error.code,
        details: error.details,
        requestId: request.id,
      })
    }

    request.log.error({ err: error }, 'Unhandled error')
    return reply.status(500).send({
      error: true,
      message: 'Internal server error',
      code: 'INTERNAL_ERROR',
      requestId: request.id,
    })
  })
}

export async function registerHealthRoutes(app: FastifyInstance) {
  const startTime = Date.now()
  let metrics = { totalRequests: 0, totalErrors: 0 }

  app.addHook('onResponse', async (_request, reply) => {
    metrics.totalRequests++
    if (reply.statusCode >= 500) metrics.totalErrors++
  })

  app.get('/health', {
    schema: {
      tags: ['health'],
      summary: 'Health check',
    },
  }, async () => ({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  }))

  app.get('/health/live', {
    schema: { tags: ['health'], summary: 'Liveness probe' },
  }, async () => ({ status: 'alive' }))

  app.get('/health/ready', {
    schema: { tags: ['health'], summary: 'Readiness probe' },
  }, async (_req, reply) => {
    const env = app.ctx.env
    const [identity, catalog, sales, redisOk] = await Promise.all([
      app.ctx.mongo.ping('identity', env.MONGO_AUTH_URI),
      app.ctx.mongo.ping('catalog', env.MONGO_CATALOG_URI),
      app.ctx.mongo.ping('sales', env.MONGO_SALES_URI),
      app.ctx.redis.ping(),
    ])

    const production = env.MONGO_PRODUCTION_URI
      ? await app.ctx.mongo.ping('production', env.MONGO_PRODUCTION_URI).catch(() => false)
      : false

    const mongoOk = identity && catalog && sales
    const ready = mongoOk

    if (!ready) {
      return reply.status(503).send({
        status: 'not_ready',
        checks: { mongo: mongoOk, redis: redisOk, identity, catalog, sales, production },
      })
    }

    return {
      status: 'ready',
      checks: { mongo: true, redis: redisOk, identity, catalog, sales, production },
    }
  })

  app.get('/health/metrics', {
    schema: { tags: ['health'], summary: 'Basic metrics' },
  }, async () => ({
    uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
    memory: process.memoryUsage(),
    cpu: process.cpuUsage(),
    requests: metrics,
  }))
}

export async function registerApiRoutes(app: FastifyInstance) {
  const { services, repos } = app.ctx
  const { requireAuth } = await import('../modules/identity/middleware/auth.middleware.js')
  const { loginSchema } = await import('../modules/identity/schemas/auth.schema.js')
  const { createOrderSchema } = await import('../modules/sales/schemas/order.schema.js')
  const {
    setAuthCookies,
    clearAuthCookies,
    getRefreshTokenFromRequest,
  } = await import('../modules/identity/utils/cookie.utils.js')
  const { getClientContext } = await import('../common/utils/request.utils.js')
  const { AppError } = await import('../common/errors/app.error.js')

  const authGuard = requireAuth(repos.sessions, services.authorization)

  // Prefix /api — compatible con rutas del frontend lumia existente
  app.register(async (api) => {
    // Auth
    api.post('/auth/login', {
      schema: {
        tags: ['auth'],
        summary: 'Login with email/password',
        body: {
          type: 'object',
          required: ['email', 'password'],
          properties: {
            email: { type: 'string' },
            password: { type: 'string' },
            rememberMe: { type: 'boolean' },
          },
        },
      },
    }, async (request, reply) => {
      const parsed = loginSchema.safeParse(request.body)
      if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())

      const ctx = getClientContext(request)
      const result = await services.auth.login({
        ...parsed.data,
        userAgent: ctx.userAgent,
        ip: ctx.ip,
        country: ctx.country,
        acceptLanguage: request.headers['accept-language'],
      })

      if ('requires2fa' in result && result.requires2fa) {
        return { requires2fa: true, tempToken: result.tempToken, userId: result.userId }
      }

      if (!('accessToken' in result)) {
        throw AppError.internal('Unexpected login response')
      }

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

    api.post('/auth/refresh', {
      schema: { tags: ['auth'], summary: 'Refresh access token' },
    }, async (request, reply) => {
      const refreshToken = getRefreshTokenFromRequest(request)
      if (!refreshToken) throw AppError.unauthorized('Missing refresh token')

      const ctx = getClientContext(request)
      const result = await services.auth.refresh(refreshToken, {
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        country: ctx.country,
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

    api.post('/auth/logout', {
      schema: { tags: ['auth'], summary: 'Logout' },
    }, async (request, reply) => {
      const refreshToken = getRefreshTokenFromRequest(request)
      const ctx = getClientContext(request)
      await services.auth.logout(refreshToken, {
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      })
      clearAuthCookies(reply, request)
      return { ok: true }
    })

    api.get('/auth/me', {
      preHandler: authGuard,
      schema: { tags: ['auth'], summary: 'Current user', security: [{ bearerAuth: [] }, { cookieAuth: [] }] },
    }, async (request) => {
      const auth = (request as import('../modules/identity/middleware/auth.middleware.js').AuthenticatedRequest).auth
      const user = await services.auth.getMe(auth.userId)
      const env = app.ctx.env
      const accessToken = request.cookies[env.COOKIE_ACCESS_NAME]
      const jwt = new (await import('../modules/identity/infrastructure/jwt.service.js')).JwtTokenService()
      const accessExpiresAt = accessToken ? jwt.getAccessExpiresAtMs(accessToken) ?? 0 : 0
      return {
        user,
        permHash: auth.permHash,
        permissionsVersion: auth.permissionsVersion,
        accessExpiresAt,
      }
    })

    await registerStoreRoutes(api, app.ctx)
    await registerPaymentRoutes(api, app.ctx)
    await registerStorePublicRoutes(api, app.ctx)
    await registerAuthExtendedRoutes(api, app.ctx)
    await registerSecurityRoutes(api, app.ctx)
    await registerAdminRoutes(api, app.ctx)
    await registerProductionAdminRoutes(api, app.ctx)
    await registerProductionPublicRoutes(api, app.ctx)

    // Products
    api.get('/products', {
      schema: { tags: ['products'], summary: 'List products' },
    }, async (request) => services.products.list(request.query as Record<string, unknown>))

    api.get('/products/:id', {
      schema: { tags: ['products'], summary: 'Get product by id or slug' },
    }, async (request, reply) => {
      const { id } = request.params as { id: string }
      const product = await services.products.getById(id)
      if (!product) return reply.status(404).send({ error: true, message: 'Product not found' })
      return product
    })

    // Categories
    api.get('/categories', {
      schema: { tags: ['categories'], summary: 'List categories' },
    }, async (request) => services.categories.list(request.query as Record<string, unknown>))

    api.get('/categories/:id', {
      schema: { tags: ['categories'], summary: 'Get category by id or slug' },
    }, async (request, reply) => {
      const { id } = request.params as { id: string }
      const category = await services.categories.getById(id)
      if (!category) return reply.status(404).send({ error: true, message: 'Category not found' })
      return category
    })

    // Orders (alias + get by id)
    api.post('/orders', {
      preHandler: authGuard,
      schema: { tags: ['orders'], summary: 'Create order (alias)', security: [{ bearerAuth: [] }] },
    }, async (request) => {
      const parsed = createOrderSchema.safeParse(request.body)
      if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
      const auth = (request as import('../modules/identity/middleware/auth.middleware.js').AuthenticatedRequest).auth
      const user = await services.auth.getMe(auth.userId)
      return services.orders.create(parsed.data, auth.userId, user.email)
    })

    api.get('/orders/:id', {
      preHandler: authGuard,
      schema: { tags: ['orders'], summary: 'Get order by id', security: [{ bearerAuth: [] }] },
    }, async (request) => {
      const { id } = request.params as { id: string }
      const auth = (request as import('../modules/identity/middleware/auth.middleware.js').AuthenticatedRequest).auth
      return services.orders.getById(id, auth.userId)
    })

    // Production status
    api.get('/production/status', {
      schema: { tags: ['production'], summary: 'Production module status' },
    }, async () =>
      getProductionModuleStatus({
        materials: repos.productionMaterials,
        suppliers: repos.productionSuppliers,
        recipes: repos.productionRecipes,
        units: repos.productionUnits,
      }),
    )
  }, { prefix: '/api' })
}

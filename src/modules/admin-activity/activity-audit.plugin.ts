import fp from 'fastify-plugin'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { AppContext } from '../../app.context.js'
import { trustedProxyClientIp } from '../../common/utils/request.utils.js'
import type { AuthenticatedRequest } from '../identity/middleware/auth.middleware.js'
import {
  diffSnapshots,
  sanitize,
  type ActivityResource,
  type ActivityResult,
} from './domain/activity-audit.js'

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const ADMIN_PREFIX = '/api/admin/'

/** Operaciones bajo /api/admin que no cambian datos administrativos (conversación con el asistente). */
const EXCLUDED = [
  /^\/api\/admin\/lumi\/chat(\/stream)?$/,
  // «No era esto»: su cuerpo es la pregunta del usuario; el aprendizaje tiene su propio registro de eventos.
  /^\/api\/admin\/lumi\/feedback$/,
  /^\/api\/admin\/lumi\/products\/:id\/assist$/,
  // Órdenes a un equipo de escritorio: el cuerpo puede llevar texto escrito en una página. Su
  // auditoría es `desktop_executions` (usuario, equipo, operación, autorización y resumen sin valores).
  /^\/api\/admin\/desktop\/devices\/:id\/executions$/,
  // Archivos de un equipo: el cuerpo es el propio archivo. Auditoría: `desktop_executions`.
  /^\/api\/admin\/desktop\/devices\/:id\/files(\/.*)?$/,
]

type Params = Record<string, string | undefined>
type Loader = (ctx: AppContext, params: Params) => Promise<unknown>

/**
 * Instantáneas de los recursos clave para guardar los valores anteriores y posteriores. El patrón
 * se compara con la ruta registrada (con parámetros), no con la URL.
 */
const SNAPSHOTS: Array<{ match: RegExp; type: string; load: Loader }> = [
  {
    match: /^\/api\/admin\/(security\/)?roles\/(archive\/|restore\/|duplicate\/)?:id$/,
    type: 'role',
    load: async (ctx, p) => {
      const role = p.id ? await ctx.repos.roles.findByIdSafe(p.id) : null
      return role ? ctx.repos.roles.toDomain(role) : null
    },
  },
  {
    match: /^\/api\/admin\/security\/users\/:id\/roles(\/:roleId)?$/,
    type: 'user-roles',
    load: async (ctx, p) =>
      p.id ? { roleIds: (await ctx.repos.userRoles.findByUserId(p.id)).map((a) => a.roleId).sort() } : null,
  },
  {
    match: /^\/api\/admin\/products\/:id(\/.*)?$/,
    type: 'product',
    load: (ctx, p) => (p.id ? ctx.services.adminProducts.get(p.id) : Promise.resolve(null)),
  },
  {
    match: /^\/api\/admin\/categories\/:id(\/.*)?$/,
    type: 'category',
    load: (ctx, p) => (p.id ? ctx.services.adminCategories.getById(p.id) : Promise.resolve(null)),
  },
  {
    match: /^\/api\/admin\/promotions\/:id(\/.*)?$/,
    type: 'promotion',
    load: (ctx, p) => (p.id ? ctx.services.adminPromotions.get(p.id) : Promise.resolve(null)),
  },
  {
    match: /^\/api\/admin\/store-banners\/:id$/,
    type: 'banner',
    load: (ctx, p) => (p.id ? ctx.services.adminBanners.get(p.id) : Promise.resolve(null)),
  },
  {
    match: /^\/api\/admin\/orders\/:id(\/.*)?$/,
    type: 'order',
    load: (ctx, p) => (p.id ? ctx.services.adminOrders.get(p.id) : Promise.resolve(null)),
  },
  {
    match: /^\/api\/admin\/lumi\/capabilities\/:id(\/.*)?$/,
    type: 'lumi-capability',
    // Sin frases de ejemplo: la auditoría guarda lo que decide el administrador, no lo que escribieron los usuarios.
    load: async (ctx, p) => {
      if (!p.id) return null
      const found = await ctx.services.lumiCapabilities.get(p.id).catch(() => null)
      if (!found) return null
      const { title, description, module, status, priority, spec, mergedInto, requestCount } = found.capability
      return { title, description, module, status, priority, spec, mergedInto, requestCount }
    },
  },
  { match: /^\/api\/admin\/store-shipping-settings(\/reset)?$/, type: 'store-shipping-settings', load: (ctx) => ctx.services.adminStore.getShippingSettings() },
  { match: /^\/api\/admin\/store-currency-settings$/, type: 'store-currency-settings', load: (ctx) => ctx.services.adminStore.getCurrencySettings() },
  { match: /^\/api\/admin\/store-customer-settings$/, type: 'store-customer-settings', load: (ctx) => ctx.services.adminStore.getCustomerSettings() },
  { match: /^\/api\/admin\/store-payment-settings$/, type: 'store-payment-settings', load: (ctx) => ctx.services.adminStore.getPaymentSettings() },
]

/** Recurso afectado a partir del patrón de ruta: "/api/admin/products/:id/variants/:sku" → products. */
export function resourceFromRoute(pattern: string, params: Params): ActivityResource {
  const snapshot = SNAPSHOTS.find((s) => s.match.test(pattern))
  const segments = pattern.slice(ADMIN_PREFIX.length).split('/').filter((s) => s && !s.startsWith(':'))
  const type = snapshot?.type ?? (segments.slice(0, 2).join('/') || 'admin')
  const id = params.id ?? params.sku ?? params.userId ?? params.key ?? null
  return { type, id: id ?? null }
}

/**
 * Reduce la respuesta de un servicio al objeto del recurso: "{ category: {...}, subcategories }"
 * → la categoría; "{ data: {...} }" → su contenido. Así los cambios quedan campo a campo.
 */
export function unwrap(value: unknown, type?: string): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    const own = type ? record[type] : undefined
    if (own && typeof own === 'object' && !Array.isArray(own)) return own
    const keys = Object.keys(value)
    if (keys.length === 1) {
      const inner = (value as Record<string, unknown>)[keys[0]!]
      if (inner && typeof inner === 'object' && !Array.isArray(inner)) return inner
    }
  }
  return value
}

export function resultFor(statusCode: number): ActivityResult {
  if (statusCode < 400) return 'success'
  return statusCode === 401 || statusCode === 403 ? 'denied' : 'failure'
}

interface ActivityState {
  pattern: string
  before?: unknown
  type?: string
  loader?: Loader
  errorCode?: string | null
}

declare module 'fastify' {
  interface FastifyRequest {
    adminActivity?: ActivityState
  }
}

/**
 * Registra cada operación de escritura en /api/admin/*: quién (usuario, IP, agente), qué
 * (método y ruta), cuándo, sobre qué recurso, cambios antes/después (recursos clave), entrada
 * saneada y resultado (también las denegadas y fallidas). Nunca guarda contraseñas, tokens,
 * secretos ni códigos 2FA.
 */
export default fp(async (app) => {
  const ctx = app.ctx

  const shouldAudit = (request: FastifyRequest): string | null => {
    if (!MUTATING.has(request.method)) return null
    const pattern = request.routeOptions?.url
    if (!pattern || !pattern.startsWith(ADMIN_PREFIX)) return null
    return EXCLUDED.some((rx) => rx.test(pattern)) ? null : pattern
  }

  app.addHook('preHandler', async (request) => {
    const pattern = shouldAudit(request)
    if (!pattern) return
    const state: ActivityState = { pattern }
    request.adminActivity = state
    const snapshot = SNAPSHOTS.find((s) => s.match.test(pattern))
    if (!snapshot) return
    // Sin credenciales la petición será rechazada: no se lee la base por ella.
    if (!request.headers.authorization && !request.cookies?.[ctx.env.COOKIE_ACCESS_NAME]) return
    state.loader = snapshot.load
    state.type = snapshot.type
    try {
      state.before = unwrap(sanitize(await snapshot.load(ctx, request.params as Params)), snapshot.type)
    } catch {
      state.before = null // el recurso no existe o no se pudo leer: el handler decidirá
    }
  })

  app.addHook('onSend', async (request, reply: FastifyReply, payload) => {
    const state = request.adminActivity
    if (state && reply.statusCode >= 400 && typeof payload === 'string') {
      try {
        const code = (JSON.parse(payload) as { code?: unknown }).code
        state.errorCode = typeof code === 'string' ? code.slice(0, 80) : null
      } catch {
        state.errorCode = null
      }
    }
    return payload
  })

  app.addHook('onResponse', async (request, reply) => {
    const pattern = request.adminActivity?.pattern ?? shouldAudit(request)
    if (!pattern) return
    const state = request.adminActivity ?? { pattern }
    const params = (request.params ?? {}) as Params
    const result = resultFor(reply.statusCode)
    const twoFactorRoute = pattern.includes('/2fa')
    const isMultipart = String(request.headers['content-type'] ?? '').startsWith('multipart/')

    let changes = null
    if (result === 'success' && state.loader) {
      let after: unknown = null
      try {
        after = unwrap(sanitize(await state.loader(ctx, params)), state.type)
      } catch {
        after = null // eliminado
      }
      changes = diffSnapshots(state.before ?? null, after)
    }

    try {
      await ctx.activityAudit.append({
        at: new Date(),
        actor: {
          userId: (request as Partial<AuthenticatedRequest>).auth?.userId ?? null,
          ip: trustedProxyClientIp(request, ctx.env.EDGE_PROXY_SECRET) ?? request.ip,
          userAgent: (request.headers['user-agent'] ?? '').slice(0, 300) || null,
        },
        action: `${request.method} ${pattern}`,
        resource: resourceFromRoute(pattern, params),
        input: isMultipart ? '[multipart]' : sanitize(request.body ?? null, { twoFactorRoute }),
        changes,
        result,
        statusCode: reply.statusCode,
        errorCode: state.errorCode ?? null,
        requestId: String(request.id),
      })
    } catch (err) {
      // La respuesta ya se envió: se deja constancia en el log para no perder el rastro.
      request.log.error({ err, action: `${request.method} ${pattern}` }, 'admin activity audit write failed')
    }
  })
})

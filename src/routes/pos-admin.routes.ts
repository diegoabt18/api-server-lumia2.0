import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { AppContext } from '../app.context.js'
import { AppError } from '../common/errors/app.error.js'
import { resolveProductHierarchyFilter } from '../modules/catalog/services/catalog-hierarchy.js'
import { PERMISSION_REGISTRY } from '../common/permissions/registry.js'
import { adminGuard } from '../modules/admin/middleware/admin-guard.js'
import type { AuthenticatedRequest } from '../modules/identity/middleware/auth.middleware.js'
import {
  posBarcodeSchema,
  posConfirmPaymentSchema,
  posSaleSchema,
  posProductSearchQuerySchema,
  posSearchQuerySchema,
} from '../modules/pos/schemas/pos.schema.js'

function readIdempotencyKey(request: FastifyRequest): string | undefined {
  const header = request.headers['idempotency-key']
  if (typeof header === 'string' && header.trim()) return header.trim()
  if (Array.isArray(header) && header[0]?.trim()) return header[0].trim()
  return undefined
}

export async function registerPosAdminRoutes(api: FastifyInstance, ctx: AppContext) {
  const g = (permission: (typeof PERMISSION_REGISTRY)[keyof typeof PERMISSION_REGISTRY]) =>
    adminGuard(ctx.repos.sessions, permission, ctx.services.authorization)

  api.get('/admin/pos/payment-methods', { preHandler: g(PERMISSION_REGISTRY.ORDERS_CREATE) }, async () =>
    ctx.services.pos.getPaymentConfig(),
  )

  api.get('/admin/pos/products', { preHandler: g(PERMISSION_REGISTRY.PRODUCTS_READ) }, async (request) => {
    const parsed = posProductSearchQuerySchema.safeParse(request.query)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    const hierarchy = await resolveProductHierarchyFilter(
      ctx.repos.categories,
      ctx.repos.subcategories,
      parsed.data.category,
      parsed.data.subcategory,
    )
    return ctx.services.pos.searchProducts(
      parsed.data.search ?? '',
      parsed.data.page,
      parsed.data.pageSize,
      hierarchy,
    )
  })

  api.get('/admin/pos/customers', { preHandler: g(PERMISSION_REGISTRY.ORDERS_READ) }, async (request) => {
    const parsed = posSearchQuerySchema.safeParse(request.query)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    const customers = await ctx.services.pos.searchCustomers(
      parsed.data.search ?? '',
      Math.min(parsed.data.limit ?? 10, 20),
    )
    return { customers }
  })

  api.post('/admin/pos/sales', { preHandler: g(PERMISSION_REGISTRY.ORDERS_CREATE) }, async (request) => {
    const parsed = posSaleSchema.safeParse(request.body)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    const auth = (request as AuthenticatedRequest).auth
    return ctx.services.pos.createSale(
      parsed.data,
      { userId: auth.userId },
      readIdempotencyKey(request),
    )
  })

  api.post('/admin/pos/sales/:id/payment/confirm', { preHandler: g(PERMISSION_REGISTRY.ORDERS_UPDATE) }, async (request) => {
    const { id } = request.params as { id: string }
    const parsed = posConfirmPaymentSchema.safeParse(request.body ?? {})
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    const auth = (request as AuthenticatedRequest).auth
    return ctx.services.pos.confirmPayment(
      id.trim(),
      { userId: auth.userId },
      parsed.data,
    )
  })

  api.get('/admin/pos/sales/:id/receipt', { preHandler: g(PERMISSION_REGISTRY.ORDERS_READ) }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const { html, filename } = await ctx.services.adminOrders.renderReceipt(id)
    return reply
      .type('text/html; charset=utf-8')
      .header('Content-Disposition', `inline; filename="${filename}"`)
      .send(html)
  })

  api.patch('/admin/pos/variants/:sku/barcode', { preHandler: g(PERMISSION_REGISTRY.PRODUCTS_UPDATE) }, async (request) => {
    const { sku } = request.params as { sku: string }
    const parsed = posBarcodeSchema.safeParse(request.body)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    return ctx.services.pos.assignBarcode(decodeURIComponent(sku), parsed.data.barcode)
  })
}

import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../app.context.js'
import { AppError } from '../common/errors/app.error.js'
import { PERMISSION_REGISTRY } from '../common/permissions/registry.js'
import { adminGuard } from '../modules/admin/middleware/admin-guard.js'
import {
  adminCancellationResolveSchema,
  adminCategorySchema,
  adminInventoryUpsertSchema,
  adminOrderPatchSchema,
  adminPaymentAmountSchema,
  adminPaymentMethodsSchema,
  adminDepositConfigureSchema,
  adminFeedbackQuestionPatchSchema,
  adminFeedbackReviewPatchSchema,
  adminProductCreateSchema,
  adminProductOptionsSchema,
  adminProductPatchSchema,
  adminPromotionActiveSchema,
  adminRevokeSessionSchema,
  adminStaffRoleSchema,
  adminVariantCreateSchema,
  adminVariantPatchSchema,
  promotionUpsertSchema,
  storeBannerUpsertSchema,
} from '../modules/admin/schemas/admin.schema.js'
import type { AuthenticatedRequest } from '../modules/identity/middleware/auth.middleware.js'

export async function registerAdminRoutes(api: FastifyInstance, ctx: AppContext) {
  const { services, repos } = ctx
  const g = (permission: (typeof PERMISSION_REGISTRY)[keyof typeof PERMISSION_REGISTRY]) =>
    adminGuard(repos.sessions, permission, services.authorization)

  // ─── Dashboard (4.1) ───
  api.get('/admin/dashboard/stats', { preHandler: g(PERMISSION_REGISTRY.ADMIN_ACCESS) }, async () =>
    services.adminDashboard.getStats(),
  )

  api.get('/admin/analytics/overview', { preHandler: g(PERMISSION_REGISTRY.ANALYTICS_READ) }, async (request) =>
    services.adminAnalytics.getOverview(request.query as Record<string, unknown>),
  )

  api.get('/admin/analytics/sales', { preHandler: g(PERMISSION_REGISTRY.ANALYTICS_READ) }, async (request) =>
    services.adminAnalytics.getSales(request.query as Record<string, unknown>),
  )

  // ─── Products (4.2) ───
  api.get('/admin/products', { preHandler: g(PERMISSION_REGISTRY.PRODUCTS_READ) }, async (request) =>
    services.adminProducts.list(request.query as Record<string, unknown>),
  )

  api.get('/admin/products/:id', { preHandler: g(PERMISSION_REGISTRY.PRODUCTS_READ) }, async (request) => {
    const { id } = request.params as { id: string }
    return services.adminProducts.get(id)
  })

  api.post('/admin/products', { preHandler: g(PERMISSION_REGISTRY.PRODUCTS_CREATE) }, async (request) => {
    const parsed = adminProductCreateSchema.safeParse(request.body)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    return services.adminProducts.create(parsed.data)
  })

  api.patch('/admin/products/:id', { preHandler: g(PERMISSION_REGISTRY.PRODUCTS_UPDATE) }, async (request) => {
    const { id } = request.params as { id: string }
    const parsed = adminProductPatchSchema.safeParse(request.body)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    return services.adminProducts.update(id, parsed.data)
  })

  api.delete('/admin/products/:id', { preHandler: g(PERMISSION_REGISTRY.PRODUCTS_DELETE) }, async (request) => {
    const { id } = request.params as { id: string }
    return services.adminProducts.delete(id)
  })

  api.get('/admin/products/:id/variants', { preHandler: g(PERMISSION_REGISTRY.PRODUCTS_READ) }, async (request) => {
    const { id } = request.params as { id: string }
    return services.adminProducts.listVariants(id)
  })

  api.post('/admin/products/:id/variants', { preHandler: g(PERMISSION_REGISTRY.PRODUCTS_UPDATE) }, async (request) => {
    const { id } = request.params as { id: string }
    const parsed = adminVariantCreateSchema.safeParse(request.body)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    return services.adminProducts.createVariant(id, parsed.data)
  })

  api.patch('/admin/products/:id/variants/:sku', { preHandler: g(PERMISSION_REGISTRY.PRODUCTS_UPDATE) }, async (request) => {
    const { id, sku } = request.params as { id: string; sku: string }
    const parsed = adminVariantPatchSchema.safeParse(request.body)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    return services.adminProducts.updateVariant(id, decodeURIComponent(sku), parsed.data)
  })

  api.delete('/admin/products/:id/variants/:sku', { preHandler: g(PERMISSION_REGISTRY.PRODUCTS_UPDATE) }, async (request) => {
    const { id, sku } = request.params as { id: string; sku: string }
    return services.adminProducts.deleteVariant(id, decodeURIComponent(sku))
  })

  api.put('/admin/products/:id/inventory/:sku', { preHandler: g(PERMISSION_REGISTRY.PRODUCTS_UPDATE) }, async (request) => {
    const { id, sku } = request.params as { id: string; sku: string }
    const parsed = adminInventoryUpsertSchema.safeParse(request.body)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    const decodedSku = decodeURIComponent(sku)
    await services.adminProducts.assertVariantBelongs(id, decodedSku)
    return services.adminInventory.upsertBySku(decodedSku, parsed.data)
  })

  api.get('/admin/products/:id/options', { preHandler: g(PERMISSION_REGISTRY.PRODUCTS_READ) }, async (request) => {
    const { id } = request.params as { id: string }
    return services.adminProducts.getOptions(id)
  })

  api.put('/admin/products/:id/options', { preHandler: g(PERMISSION_REGISTRY.PRODUCTS_UPDATE) }, async (request) => {
    const { id } = request.params as { id: string }
    const parsed = adminProductOptionsSchema.safeParse(request.body)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    return services.adminProducts.putOptions(id, parsed.data.axes)
  })

  // ─── Categories (4.3) ───
  api.get('/admin/categories', { preHandler: g(PERMISSION_REGISTRY.CATEGORIES_READ) }, async (request) =>
    services.adminCategories.list(request.query as Record<string, unknown>),
  )

  api.post('/admin/categories', { preHandler: g(PERMISSION_REGISTRY.CATEGORIES_CREATE) }, async (request) => {
    const parsed = adminCategorySchema.safeParse(request.body)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    return services.adminCategories.create(parsed.data.name, parsed.data.slug)
  })

  api.patch('/admin/categories/:id', { preHandler: g(PERMISSION_REGISTRY.CATEGORIES_UPDATE) }, async (request) => {
    const { id } = request.params as { id: string }
    const parsed = adminCategorySchema.partial().safeParse(request.body)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    return services.adminCategories.update(id, parsed.data)
  })

  api.delete('/admin/categories/:id', { preHandler: g(PERMISSION_REGISTRY.CATEGORIES_DELETE) }, async (request) => {
    const { id } = request.params as { id: string }
    return services.adminCategories.delete(id)
  })

  // ─── Orders (4.4) ───
  api.get('/admin/orders', { preHandler: g(PERMISSION_REGISTRY.ORDERS_READ) }, async (request) =>
    services.adminOrders.list(request.query as Record<string, unknown>),
  )

  api.get('/admin/orders/:id', { preHandler: g(PERMISSION_REGISTRY.ORDERS_READ) }, async (request) => {
    const { id } = request.params as { id: string }
    return services.adminOrders.get(id)
  })

  api.patch('/admin/orders/:id', { preHandler: g(PERMISSION_REGISTRY.ORDERS_UPDATE) }, async (request) => {
    const { id } = request.params as { id: string }
    const parsed = adminOrderPatchSchema.safeParse(request.body)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    const auth = (request as AuthenticatedRequest).auth
    return services.adminOrders.patch(id, parsed.data, auth.userId)
  })

  api.patch('/admin/orders/:id/cancellation', { preHandler: g(PERMISSION_REGISTRY.ORDERS_UPDATE) }, async (request) => {
    const { id } = request.params as { id: string }
    const parsed = adminCancellationResolveSchema.safeParse(request.body)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    const auth = (request as AuthenticatedRequest).auth
    return services.adminOrders.resolveCancellation(id, parsed.data.resolution, auth.userId, parsed.data.adminNote)
  })

  api.post('/admin/orders/:id/deposit', { preHandler: g(PERMISSION_REGISTRY.ORDERS_UPDATE) }, async (request) => {
    const { id } = request.params as { id: string }
    const parsed = adminDepositConfigureSchema.safeParse(request.body)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    const auth = (request as AuthenticatedRequest).auth
    return services.adminOrders.configureDeposit(id, parsed.data.percentage, auth.userId)
  })

  api.post('/admin/orders/:id/deposit/pay', { preHandler: g(PERMISSION_REGISTRY.ORDERS_UPDATE) }, async (request) => {
    const { id } = request.params as { id: string }
    const parsed = adminPaymentAmountSchema.safeParse(request.body)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    const auth = (request as AuthenticatedRequest).auth
    return services.adminOrders.markDepositPaid(id, parsed.data.amount, auth.userId, parsed.data.note)
  })

  api.post('/admin/orders/:id/final-payment/pay', { preHandler: g(PERMISSION_REGISTRY.ORDERS_UPDATE) }, async (request) => {
    const { id } = request.params as { id: string }
    const parsed = adminPaymentAmountSchema.safeParse(request.body)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    const auth = (request as AuthenticatedRequest).auth
    return services.adminOrders.markFinalPaymentPaid(id, parsed.data.amount, auth.userId, parsed.data.note)
  })

  api.get('/admin/orders/:id/invoice', { preHandler: g(PERMISSION_REGISTRY.ORDERS_READ) }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const { html, filename } = await services.adminOrders.renderInvoice(id)
    return reply.type('text/html; charset=utf-8').header('Content-Disposition', `inline; filename="${filename}"`).send(html)
  })

  // ─── Store settings (4.6) ───
  api.get('/admin/store-shipping-settings', { preHandler: g(PERMISSION_REGISTRY.ADMIN_ACCESS) }, async () =>
    services.adminStore.getShippingSettings(),
  )

  api.put('/admin/store-shipping-settings', { preHandler: g(PERMISSION_REGISTRY.ADMIN_ACCESS) }, async (request) => {
    const body = request.body as Record<string, unknown>
    if (!body || typeof body !== 'object') throw AppError.badRequest('Invalid input')
    return services.adminStore.putShippingSettings(body as never)
  })

  api.post('/admin/store-shipping-settings/reset', { preHandler: g(PERMISSION_REGISTRY.ADMIN_ACCESS) }, async () =>
    services.adminStore.resetShippingSettings(),
  )

  api.get('/admin/store-currency-settings', { preHandler: g(PERMISSION_REGISTRY.ADMIN_ACCESS) }, async () =>
    services.adminStore.getCurrencySettings(),
  )

  api.patch('/admin/store-currency-settings', { preHandler: g(PERMISSION_REGISTRY.ADMIN_ACCESS) }, async (request) => {
    const body = request.body as Record<string, unknown>
    if (!body || typeof body !== 'object') throw AppError.badRequest('Invalid input')
    return services.adminStore.patchCurrencySettings(body as never)
  })

  api.get('/admin/store-customer-settings', { preHandler: g(PERMISSION_REGISTRY.ADMIN_ACCESS) }, async () =>
    services.adminStore.getCustomerSettings(),
  )

  api.patch('/admin/store-customer-settings', { preHandler: g(PERMISSION_REGISTRY.ADMIN_ACCESS) }, async (request) => {
    const body = request.body as Record<string, unknown>
    if (!body || typeof body !== 'object') throw AppError.badRequest('Invalid input')
    return services.adminStore.patchCustomerSettings(body as never)
  })

  api.get('/admin/store-payment-settings', { preHandler: g(PERMISSION_REGISTRY.ADMIN_ACCESS) }, async () =>
    services.adminStore.getPaymentSettings(),
  )

  api.patch('/admin/store-payment-settings', { preHandler: g(PERMISSION_REGISTRY.ADMIN_ACCESS) }, async (request) => {
    const parsed = adminPaymentMethodsSchema.safeParse(request.body)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    return services.adminStore.patchPaymentSettings(parsed.data.methods)
  })

  // ─── Promotions (4.3) ───
  api.get('/admin/promotions', { preHandler: g(PERMISSION_REGISTRY.PRODUCTS_READ) }, async (request) =>
    services.adminPromotions.list(request.query as Record<string, unknown>),
  )

  api.get('/admin/promotions/products', { preHandler: g(PERMISSION_REGISTRY.PRODUCTS_READ) }, async (request) =>
    services.adminProducts.listPromotionProducts(request.query as Record<string, unknown>),
  )

  api.get('/admin/promotions/:id', { preHandler: g(PERMISSION_REGISTRY.PRODUCTS_READ) }, async (request) => {
    const { id } = request.params as { id: string }
    return services.adminPromotions.get(id)
  })

  api.post('/admin/promotions', { preHandler: g(PERMISSION_REGISTRY.PRODUCTS_UPDATE) }, async (request) => {
    const parsed = promotionUpsertSchema.safeParse(request.body)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    return services.adminPromotions.create(parsed.data)
  })

  api.patch('/admin/promotions/:id', { preHandler: g(PERMISSION_REGISTRY.PRODUCTS_UPDATE) }, async (request) => {
    const { id } = request.params as { id: string }
    const parsed = promotionUpsertSchema.safeParse(request.body)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    return services.adminPromotions.update(id, parsed.data)
  })

  api.delete('/admin/promotions/:id', { preHandler: g(PERMISSION_REGISTRY.PRODUCTS_UPDATE) }, async (request) => {
    const { id } = request.params as { id: string }
    return services.adminPromotions.delete(id)
  })

  api.patch('/admin/promotions/:id/active', { preHandler: g(PERMISSION_REGISTRY.PRODUCTS_UPDATE) }, async (request) => {
    const { id } = request.params as { id: string }
    const parsed = adminPromotionActiveSchema.safeParse(request.body)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    return services.adminPromotions.setActive(id, parsed.data.active)
  })

  // ─── Banners (4.3) ───
  api.get('/admin/store-banners', { preHandler: g(PERMISSION_REGISTRY.PRODUCTS_READ) }, async () =>
    services.adminBanners.list(),
  )

  api.get('/admin/store-banners/:id', { preHandler: g(PERMISSION_REGISTRY.PRODUCTS_READ) }, async (request) => {
    const { id } = request.params as { id: string }
    return services.adminBanners.get(id)
  })

  api.post('/admin/store-banners', { preHandler: g(PERMISSION_REGISTRY.PRODUCTS_UPDATE) }, async (request) => {
    const parsed = storeBannerUpsertSchema.safeParse(request.body)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    return services.adminBanners.create(parsed.data)
  })

  api.patch('/admin/store-banners/:id', { preHandler: g(PERMISSION_REGISTRY.PRODUCTS_UPDATE) }, async (request) => {
    const { id } = request.params as { id: string }
    const parsed = storeBannerUpsertSchema.safeParse(request.body)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    return services.adminBanners.update(id, parsed.data)
  })

  api.delete('/admin/store-banners/:id', { preHandler: g(PERMISSION_REGISTRY.PRODUCTS_UPDATE) }, async (request) => {
    const { id } = request.params as { id: string }
    return services.adminBanners.delete(id)
  })

  // ─── Inventory (4.5) ───
  api.get('/admin/inventory', { preHandler: g(PERMISSION_REGISTRY.PRODUCTS_READ) }, async (request) =>
    services.adminInventory.list(request.query as Record<string, unknown>),
  )

  api.put('/admin/inventory/:sku', { preHandler: g(PERMISSION_REGISTRY.PRODUCTS_UPDATE) }, async (request) => {
    const { sku } = request.params as { sku: string }
    const parsed = adminInventoryUpsertSchema.safeParse(request.body)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    return services.adminInventory.upsertBySku(decodeURIComponent(sku), parsed.data)
  })

  // ─── Staff users (4.7) ───
  api.get('/admin/staff-users', { preHandler: g(PERMISSION_REGISTRY.ADMIN_USERS_READ) }, async (request) =>
    services.adminStaff.list(request.query as Record<string, unknown>),
  )

  api.get('/admin/staff-users/:id', { preHandler: g(PERMISSION_REGISTRY.ADMIN_USERS_READ) }, async (request) => {
    const { id } = request.params as { id: string }
    return services.adminStaff.get(id)
  })

  api.post('/admin/staff-users/:id/roles', { preHandler: g(PERMISSION_REGISTRY.ADMIN_USERS_MANAGE) }, async (request) => {
    const { id } = request.params as { id: string }
    const parsed = adminStaffRoleSchema.safeParse(request.body)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    return services.adminStaff.updateRole(id, parsed.data.role)
  })

  api.delete('/admin/staff-users/:id/roles', { preHandler: g(PERMISSION_REGISTRY.ADMIN_USERS_MANAGE) }, async (request) => {
    const { id } = request.params as { id: string }
    return services.adminStaff.removeRole(id)
  })

  // ─── Session admin ───
  api.get('/admin/session-status', { preHandler: g(PERMISSION_REGISTRY.ADMIN_ACCESS) }, async (request) => {
    const auth = (request as AuthenticatedRequest).auth
    return services.adminSession.sessionStatus(auth.userId)
  })

  api.post('/admin/sessions/revoke', { preHandler: g(PERMISSION_REGISTRY.ADMIN_SESSIONS_REVOKE) }, async (request) => {
    const parsed = adminRevokeSessionSchema.safeParse(request.body)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    const auth = (request as AuthenticatedRequest).auth
    return services.adminSession.revokeSession(auth.sessionId, parsed.data.sessionId)
  })

  // ─── Registry (4.8) ───
  api.get('/admin/registry', { preHandler: g(PERMISSION_REGISTRY.ADMIN_PERMISSIONS_READ) }, async () =>
    services.adminRegistry.getFullRegistry(),
  )

  api.get('/admin/registry/modules', { preHandler: g(PERMISSION_REGISTRY.ADMIN_PERMISSIONS_READ) }, async () =>
    services.adminRegistry.listModules(),
  )

  api.get('/admin/registry/services', { preHandler: g(PERMISSION_REGISTRY.ADMIN_PERMISSIONS_READ) }, async () =>
    services.adminRegistry.listServices(),
  )

  api.post('/admin/registry/sync', { preHandler: g(PERMISSION_REGISTRY.ADMIN_PERMISSIONS_MANAGE) }, async () =>
    services.adminRegistry.syncFromSeeds(),
  )

  // ─── Feedback moderation ───
  api.get('/admin/feedback/reports', { preHandler: g(PERMISSION_REGISTRY.ADMIN_ACCESS) }, async (request) =>
    services.adminFeedback.listReports(request.query as Record<string, unknown>),
  )

  api.patch('/admin/feedback/reviews/:id', { preHandler: g(PERMISSION_REGISTRY.ADMIN_ACCESS) }, async (request) => {
    const { id } = request.params as { id: string }
    const parsed = adminFeedbackReviewPatchSchema.safeParse(request.body)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    return services.adminFeedback.patchReview(id, parsed.data)
  })

  api.patch('/admin/feedback/questions/:id', { preHandler: g(PERMISSION_REGISTRY.ADMIN_ACCESS) }, async (request) => {
    const { id } = request.params as { id: string }
    const parsed = adminFeedbackQuestionPatchSchema.safeParse(request.body)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    return services.adminFeedback.patchQuestion(id, parsed.data)
  })
}

import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../app.context.js'
import { AppError } from '../common/errors/app.error.js'
import { PERMISSION_REGISTRY } from '../common/permissions/registry.js'
import { adminGuard } from '../modules/admin/middleware/admin-guard.js'
import type { AuthenticatedRequest } from '../modules/identity/middleware/auth.middleware.js'
import {
  approvalIdsSchema,
  calculateCostSchema,
  createGlobalIndirectCostSchema,
  createMaterialPriceSchema,
  createMaterialSchema,
  createRecipeSchema,
  createSupplierSchema,
  createUnitEquivalenceSchema,
  createUnitSchema,
  rejectApprovalSchema,
  stripNulls,
  suggestPriceSchema,
  updateGlobalIndirectCostSchema,
  updateMaterialSchema,
  updateProductionConfigSchema,
  updateRecipeSchema,
  updateSupplierSchema,
  updateUnitEquivalenceSchema,
  updateUnitSchema,
  upsertLaborCostSchema,
  upsertPackagingCostSchema,
  upsertProductionCostSchema,
  upsertServiceCostSchema,
} from '../modules/production/schemas/production.schema.js'

export async function registerProductionAdminRoutes(api: FastifyInstance, ctx: AppContext) {
  const { services, repos } = ctx
  const g = (permission: (typeof PERMISSION_REGISTRY)[keyof typeof PERMISSION_REGISTRY]) =>
    adminGuard(repos.sessions, permission, services.authorization)

  const userId = (request: unknown) => (request as AuthenticatedRequest).auth.userId

  // ─── Materials ───
  api.get('/admin/production/materials', { preHandler: g(PERMISSION_REGISTRY.MATERIALS_READ) }, async (request) =>
    services.productionMaterials.list(request.query as Record<string, unknown>),
  )

  api.post('/admin/production/materials', { preHandler: g(PERMISSION_REGISTRY.MATERIALS_CREATE) }, async (request) => {
    const parsed = createMaterialSchema.safeParse(stripNulls((request.body ?? {}) as Record<string, unknown>))
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    return services.productionMaterials.create(parsed.data, userId(request))
  })

  api.get('/admin/production/materials/:id', { preHandler: g(PERMISSION_REGISTRY.MATERIALS_READ) }, async (request) => {
    const { id } = request.params as { id: string }
    return services.productionMaterials.get(id)
  })

  api.patch('/admin/production/materials/:id', { preHandler: g(PERMISSION_REGISTRY.MATERIALS_UPDATE) }, async (request) => {
    const { id } = request.params as { id: string }
    const parsed = updateMaterialSchema.safeParse(stripNulls((request.body ?? {}) as Record<string, unknown>))
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    return services.productionMaterials.update(id, parsed.data, userId(request))
  })

  api.delete('/admin/production/materials/:id', { preHandler: g(PERMISSION_REGISTRY.MATERIALS_DELETE) }, async (request) => {
    const { id } = request.params as { id: string }
    return services.productionMaterials.delete(id)
  })

  api.get('/admin/production/materials/:id/price-history', { preHandler: g(PERMISSION_REGISTRY.MATERIALS_READ) }, async (request) => {
    const { id } = request.params as { id: string }
    return services.productionMaterials.listPriceHistory(id)
  })

  api.post('/admin/production/materials/:id/price-history', { preHandler: g(PERMISSION_REGISTRY.MATERIALS_UPDATE) }, async (request) => {
    const { id } = request.params as { id: string }
    const parsed = createMaterialPriceSchema.safeParse(stripNulls((request.body ?? {}) as Record<string, unknown>))
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    return services.productionMaterials.registerPrice(id, parsed.data, userId(request))
  })

  api.post('/admin/production/materials/images/generate', { preHandler: g(PERMISSION_REGISTRY.MATERIALS_UPDATE) }, async () =>
    services.productionMaterials.generateImage(),
  )

  // ─── Suppliers ───
  api.get('/admin/production/suppliers', { preHandler: g(PERMISSION_REGISTRY.SUPPLIERS_READ) }, async (request) =>
    services.productionSuppliers.list(request.query as Record<string, unknown>),
  )

  api.post('/admin/production/suppliers', { preHandler: g(PERMISSION_REGISTRY.SUPPLIERS_CREATE) }, async (request) => {
    const parsed = createSupplierSchema.safeParse(stripNulls((request.body ?? {}) as Record<string, unknown>))
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    return services.productionSuppliers.create(parsed.data)
  })

  api.get('/admin/production/suppliers/:id', { preHandler: g(PERMISSION_REGISTRY.SUPPLIERS_READ) }, async (request) => {
    const { id } = request.params as { id: string }
    return services.productionSuppliers.get(id)
  })

  api.patch('/admin/production/suppliers/:id', { preHandler: g(PERMISSION_REGISTRY.SUPPLIERS_UPDATE) }, async (request) => {
    const { id } = request.params as { id: string }
    const parsed = updateSupplierSchema.safeParse(stripNulls((request.body ?? {}) as Record<string, unknown>))
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    return services.productionSuppliers.update(id, parsed.data)
  })

  api.delete('/admin/production/suppliers/:id', { preHandler: g(PERMISSION_REGISTRY.SUPPLIERS_DELETE) }, async (request) => {
    const { id } = request.params as { id: string }
    return services.productionSuppliers.delete(id)
  })

  // ─── Recipes ───
  api.get('/admin/production/recipes', { preHandler: g(PERMISSION_REGISTRY.RECIPES_READ) }, async (request) =>
    services.productionRecipes.list(request.query as Record<string, unknown>),
  )

  api.post('/admin/production/recipes', { preHandler: g(PERMISSION_REGISTRY.RECIPES_CREATE) }, async (request) => {
    const parsed = createRecipeSchema.safeParse(stripNulls((request.body ?? {}) as Record<string, unknown>))
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    return services.productionRecipes.create(parsed.data, userId(request))
  })

  api.get('/admin/production/recipes/products', { preHandler: g(PERMISSION_REGISTRY.RECIPES_READ) }, async (request) =>
    services.productionRecipes.listProducts(request.query as Record<string, unknown>),
  )

  api.post('/admin/production/recipes/recalculate-all', { preHandler: g(PERMISSION_REGISTRY.RECIPES_UPDATE) }, async (request) =>
    services.productionRecipes.recalculateAll(userId(request)),
  )

  api.get('/admin/production/recipes/:id', { preHandler: g(PERMISSION_REGISTRY.RECIPES_READ) }, async (request) => {
    const { id } = request.params as { id: string }
    return services.productionRecipes.get(id)
  })

  api.patch('/admin/production/recipes/:id', { preHandler: g(PERMISSION_REGISTRY.RECIPES_UPDATE) }, async (request) => {
    const { id } = request.params as { id: string }
    const parsed = updateRecipeSchema.safeParse(stripNulls((request.body ?? {}) as Record<string, unknown>))
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    return services.productionRecipes.update(id, parsed.data, userId(request))
  })

  api.delete('/admin/production/recipes/:id', { preHandler: g(PERMISSION_REGISTRY.RECIPES_DELETE) }, async (request) => {
    const { id } = request.params as { id: string }
    return services.productionRecipes.delete(id, userId(request))
  })

  api.post('/admin/production/recipes/:id/calculate-cost', { preHandler: g(PERMISSION_REGISTRY.RECIPES_UPDATE) }, async (request) => {
    const { id } = request.params as { id: string }
    return services.productionRecipes.calculateCost(id, userId(request))
  })

  api.get('/admin/production/recipes/:id/versions', { preHandler: g(PERMISSION_REGISTRY.RECIPES_READ) }, async (request) => {
    const { id } = request.params as { id: string }
    return services.productionRecipes.getVersions(id)
  })

  api.get('/admin/production/recipes/:id/associated-products', { preHandler: g(PERMISSION_REGISTRY.RECIPES_READ) }, async (request) => {
    const { id } = request.params as { id: string }
    return services.productionRecipes.getAssociatedProducts(id)
  })

  api.get('/admin/production/recipes/:id/cost-sheets', { preHandler: g(PERMISSION_REGISTRY.COSTING_READ) }, async (request) => {
    const { id } = request.params as { id: string }
    return services.productionRecipes.getCostSheets(id)
  })

  api.get('/admin/production/recipes/:id/labor-cost', { preHandler: g(PERMISSION_REGISTRY.RECIPES_READ) }, async (request) => {
    const { id } = request.params as { id: string }
    return services.productionRecipes.getLaborCost(id)
  })

  api.put('/admin/production/recipes/:id/labor-cost', { preHandler: g(PERMISSION_REGISTRY.RECIPES_UPDATE) }, async (request) => {
    const { id } = request.params as { id: string }
    const parsed = upsertLaborCostSchema.safeParse(request.body ?? {})
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    return services.productionRecipes.upsertLaborCost(id, parsed.data)
  })

  api.get('/admin/production/recipes/:id/packaging-cost', { preHandler: g(PERMISSION_REGISTRY.RECIPES_READ) }, async (request) => {
    const { id } = request.params as { id: string }
    return services.productionRecipes.getPackagingCost(id)
  })

  api.put('/admin/production/recipes/:id/packaging-cost', { preHandler: g(PERMISSION_REGISTRY.RECIPES_UPDATE) }, async (request) => {
    const { id } = request.params as { id: string }
    const parsed = upsertPackagingCostSchema.safeParse(request.body ?? {})
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    return services.productionRecipes.upsertPackagingCost(id, parsed.data)
  })

  api.get('/admin/production/recipes/:id/production-cost', { preHandler: g(PERMISSION_REGISTRY.RECIPES_READ) }, async (request) => {
    const { id } = request.params as { id: string }
    return services.productionRecipes.getProductionCost(id)
  })

  api.put('/admin/production/recipes/:id/production-cost', { preHandler: g(PERMISSION_REGISTRY.RECIPES_UPDATE) }, async (request) => {
    const { id } = request.params as { id: string }
    const parsed = upsertProductionCostSchema.safeParse(request.body ?? {})
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    return services.productionRecipes.upsertProductionCost(id, parsed.data)
  })

  api.get('/admin/production/recipes/:id/service-cost', { preHandler: g(PERMISSION_REGISTRY.RECIPES_READ) }, async (request) => {
    const { id } = request.params as { id: string }
    return services.productionRecipes.getServiceCost(id)
  })

  api.put('/admin/production/recipes/:id/service-cost', { preHandler: g(PERMISSION_REGISTRY.RECIPES_UPDATE) }, async (request) => {
    const { id } = request.params as { id: string }
    const parsed = upsertServiceCostSchema.safeParse(request.body ?? {})
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    return services.productionRecipes.upsertServiceCost(id, parsed.data)
  })

  // ─── Units ───
  api.get('/admin/production/units', { preHandler: g(PERMISSION_REGISTRY.UNITS_READ) }, async (request) =>
    services.productionUnits.list(request.query as Record<string, unknown>),
  )

  api.post('/admin/production/units', { preHandler: g(PERMISSION_REGISTRY.UNITS_CREATE) }, async (request) => {
    const parsed = createUnitSchema.safeParse(stripNulls((request.body ?? {}) as Record<string, unknown>))
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    return services.productionUnits.create(parsed.data)
  })

  api.get('/admin/production/units/:id', { preHandler: g(PERMISSION_REGISTRY.UNITS_READ) }, async (request) => {
    const { id } = request.params as { id: string }
    return services.productionUnits.get(id)
  })

  api.patch('/admin/production/units/:id', { preHandler: g(PERMISSION_REGISTRY.UNITS_UPDATE) }, async (request) => {
    const { id } = request.params as { id: string }
    const parsed = updateUnitSchema.safeParse(stripNulls((request.body ?? {}) as Record<string, unknown>))
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    return services.productionUnits.update(id, parsed.data)
  })

  api.delete('/admin/production/units/:id', { preHandler: g(PERMISSION_REGISTRY.UNITS_DELETE) }, async (request) => {
    const { id } = request.params as { id: string }
    return services.productionUnits.delete(id)
  })

  // ─── Config & Dashboard ───
  api.get('/admin/production/config', { preHandler: g(PERMISSION_REGISTRY.PRODUCTION_CONFIG_READ) }, async () =>
    services.productionConfig.get(),
  )

  api.put('/admin/production/config', { preHandler: g(PERMISSION_REGISTRY.PRODUCTION_CONFIG_MANAGE) }, async (request) => {
    const parsed = updateProductionConfigSchema.safeParse(stripNulls((request.body ?? {}) as Record<string, unknown>))
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    return services.productionConfig.update(parsed.data, userId(request))
  })

  api.get('/admin/production/dashboard', { preHandler: g(PERMISSION_REGISTRY.COSTING_READ) }, async () =>
    services.productionDashboard.getDashboard(),
  )

  api.get('/admin/production/audit', { preHandler: g(PERMISSION_REGISTRY.COSTING_READ) }, async (request) =>
    services.productionAudit.list(request.query as Record<string, unknown>),
  )

  api.post('/admin/production/costing/calculate', { preHandler: g(PERMISSION_REGISTRY.COSTING_MANAGE) }, async (request) => {
    const parsed = calculateCostSchema.safeParse(request.body ?? {})
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    try {
      return await services.productionCosting.calculateRecipeCost(parsed.data.recipeId, userId(request))
    } catch (e) {
      throw AppError.badRequest(e instanceof Error ? e.message : 'Error al calcular costo')
    }
  })

  api.get('/admin/production/costing/products-outdated', { preHandler: g(PERMISSION_REGISTRY.COSTING_READ) }, async () =>
    services.productionCosting.getOutdatedProducts(),
  )

  api.post('/admin/production/costing/recalculate-all', { preHandler: g(PERMISSION_REGISTRY.COSTING_MANAGE) }, async (request) =>
    services.productionCosting.recalculateAll(userId(request)),
  )

  api.post('/admin/production/costing/suggest-price', { preHandler: g(PERMISSION_REGISTRY.COSTING_READ) }, async (request) => {
    const parsed = suggestPriceSchema.safeParse(request.body ?? {})
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    return services.productionCosting.suggestPrice(parsed.data)
  })

  // ─── Unit Equivalences ───
  api.get('/admin/production/equivalences', { preHandler: g(PERMISSION_REGISTRY.EQUIVALENCES_READ) }, async (request) =>
    services.productionEquivalences.list(request.query as Record<string, unknown>),
  )

  api.post('/admin/production/equivalences', { preHandler: g(PERMISSION_REGISTRY.EQUIVALENCES_CREATE) }, async (request) => {
    const parsed = createUnitEquivalenceSchema.safeParse(stripNulls((request.body ?? {}) as Record<string, unknown>))
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    return services.productionEquivalences.create(parsed.data)
  })

  api.get('/admin/production/equivalences/:equivalenceId', { preHandler: g(PERMISSION_REGISTRY.EQUIVALENCES_READ) }, async (request) => {
    const { equivalenceId } = request.params as { equivalenceId: string }
    return services.productionEquivalences.get(equivalenceId)
  })

  api.patch('/admin/production/equivalences/:equivalenceId', { preHandler: g(PERMISSION_REGISTRY.EQUIVALENCES_UPDATE) }, async (request) => {
    const { equivalenceId } = request.params as { equivalenceId: string }
    const parsed = updateUnitEquivalenceSchema.safeParse(stripNulls((request.body ?? {}) as Record<string, unknown>))
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    return services.productionEquivalences.update(equivalenceId, parsed.data)
  })

  api.delete('/admin/production/equivalences/:equivalenceId', { preHandler: g(PERMISSION_REGISTRY.EQUIVALENCES_DELETE) }, async (request) => {
    const { equivalenceId } = request.params as { equivalenceId: string }
    return services.productionEquivalences.delete(equivalenceId)
  })

  // ─── Indirect Costs (global) ───
  api.get('/admin/production/indirect-costs', { preHandler: g(PERMISSION_REGISTRY.RECIPES_READ) }, async (request) =>
    services.productionIndirectCosts.list(request.query as Record<string, unknown>),
  )

  api.post('/admin/production/indirect-costs', { preHandler: g(PERMISSION_REGISTRY.RECIPES_UPDATE) }, async (request) => {
    const parsed = createGlobalIndirectCostSchema.safeParse(stripNulls((request.body ?? {}) as Record<string, unknown>))
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    return services.productionIndirectCosts.create(parsed.data)
  })

  api.patch('/admin/production/indirect-costs/:id', { preHandler: g(PERMISSION_REGISTRY.RECIPES_UPDATE) }, async (request) => {
    const { id } = request.params as { id: string }
    const parsed = updateGlobalIndirectCostSchema.safeParse(stripNulls((request.body ?? {}) as Record<string, unknown>))
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    return services.productionIndirectCosts.update(id, parsed.data)
  })

  api.delete('/admin/production/indirect-costs/:id', { preHandler: g(PERMISSION_REGISTRY.RECIPES_UPDATE) }, async (request) => {
    const { id } = request.params as { id: string }
    return services.productionIndirectCosts.delete(id)
  })

  // ─── Price Approvals ───
  api.get('/admin/production/approvals', { preHandler: g(PERMISSION_REGISTRY.COSTING_READ) }, async (request) =>
    services.productionApprovals.list(request.query as Record<string, unknown>),
  )

  api.get('/admin/production/approvals/summary', { preHandler: g(PERMISSION_REGISTRY.COSTING_READ) }, async () =>
    services.productionApprovals.summary(),
  )

  api.post('/admin/production/approvals/approve', { preHandler: g(PERMISSION_REGISTRY.COSTING_MANAGE) }, async (request) => {
    const parsed = approvalIdsSchema.safeParse(request.body ?? {})
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    return services.productionApprovals.approve(parsed.data.approvalIds, userId(request))
  })

  api.post('/admin/production/approvals/reject', { preHandler: g(PERMISSION_REGISTRY.COSTING_MANAGE) }, async (request) => {
    const parsed = rejectApprovalSchema.safeParse(request.body ?? {})
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    return services.productionApprovals.reject(parsed.data.approvalIds, parsed.data.reason, userId(request))
  })

  api.post('/admin/production/approvals/publish', { preHandler: g(PERMISSION_REGISTRY.COSTING_MANAGE) }, async (request) => {
    const parsed = approvalIdsSchema.safeParse(request.body ?? {})
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    return services.productionApprovals.publish(parsed.data.approvalIds, userId(request))
  })

  // ─── Cost Impact ───
  api.get('/admin/production/impact', { preHandler: g(PERMISSION_REGISTRY.COSTING_READ) }, async (request) =>
    services.productionImpact.list(request.query as Record<string, unknown>),
  )

  api.get('/admin/production/impact/summary', { preHandler: g(PERMISSION_REGISTRY.COSTING_READ) }, async () =>
    services.productionImpact.summary(),
  )

  api.post('/admin/production/impact/:id/resolve', { preHandler: g(PERMISSION_REGISTRY.COSTING_MANAGE) }, async (request) => {
    const { id } = request.params as { id: string }
    return services.productionImpact.resolve(id, userId(request))
  })
}

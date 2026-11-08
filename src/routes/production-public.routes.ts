import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../app.context.js'
import { AppError } from '../common/errors/app.error.js'
import { PERMISSION_REGISTRY } from '../common/permissions/registry.js'
import { adminGuard } from '../modules/admin/middleware/admin-guard.js'
import {
  unitConvertSchema,
  unitCostCalculateSchema,
  validateFamilySchema,
} from '../modules/production/schemas/production.schema.js'

/**
 * Conversión de unidades y cálculo de costo. Antes eran públicas; ahora exigen sesión administrativa
 * y el permiso correspondiente. Ninguna pantalla de la tienda las usaba.
 */
export async function registerProductionPublicRoutes(api: FastifyInstance, ctx: AppContext) {
  const { services, repos } = ctx
  const g = (permission: (typeof PERMISSION_REGISTRY)[keyof typeof PERMISSION_REGISTRY]) =>
    adminGuard(repos.sessions, permission, services.authorization)

  api.get('/production/unit-conversion', { preHandler: g(PERMISSION_REGISTRY.PRODUCTION_CONFIG_READ) }, async () => {
    const config = await services.productionUnitConversion.getConfig()
    return { data: config }
  })

  api.post('/production/unit-conversion/convert', { preHandler: g(PERMISSION_REGISTRY.MATERIALS_READ) }, async (request) => {
    const parsed = unitConvertSchema.safeParse(request.body ?? {})
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    try {
      const result = await services.productionUnitConversion.convert(parsed.data)
      return { data: result }
    } catch (e) {
      throw AppError.badRequest(e instanceof Error ? e.message : 'Error en conversión')
    }
  })

  api.post('/production/unit-conversion/calculate-cost', { preHandler: g(PERMISSION_REGISTRY.COSTING_MANAGE) }, async (request) => {
    const parsed = unitCostCalculateSchema.safeParse(request.body ?? {})
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    try {
      const result = await services.productionUnitConversion.calculateCost(parsed.data)
      return { data: result }
    } catch (e) {
      throw AppError.badRequest(e instanceof Error ? e.message : 'Error en cálculo de costo')
    }
  })

  api.post('/production/unit-conversion/validate-family', { preHandler: g(PERMISSION_REGISTRY.MATERIALS_READ) }, async (request) => {
    const parsed = validateFamilySchema.safeParse(request.body ?? {})
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    const result = await services.productionUnitConversion.validateFamily(parsed.data.unitA, parsed.data.unitB)
    return { data: { valid: result.valid, family: result.family ?? false, error: result.error } }
  })
}

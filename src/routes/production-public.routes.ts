import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../app.context.js'
import { AppError } from '../common/errors/app.error.js'
import {
  unitConvertSchema,
  unitCostCalculateSchema,
  validateFamilySchema,
} from '../modules/production/schemas/production.schema.js'

export async function registerProductionPublicRoutes(api: FastifyInstance, ctx: AppContext) {
  const { services } = ctx

  api.get('/production/unit-conversion', async () => {
    const config = await services.productionUnitConversion.getConfig()
    return { data: config }
  })

  api.post('/production/unit-conversion/convert', async (request) => {
    const parsed = unitConvertSchema.safeParse(request.body ?? {})
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    try {
      const result = await services.productionUnitConversion.convert(parsed.data)
      return { data: result }
    } catch (e) {
      throw AppError.badRequest(e instanceof Error ? e.message : 'Error en conversión')
    }
  })

  api.post('/production/unit-conversion/calculate-cost', async (request) => {
    const parsed = unitCostCalculateSchema.safeParse(request.body ?? {})
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    try {
      const result = await services.productionUnitConversion.calculateCost(parsed.data)
      return { data: result }
    } catch (e) {
      throw AppError.badRequest(e instanceof Error ? e.message : 'Error en cálculo de costo')
    }
  })

  api.post('/production/unit-conversion/validate-family', async (request) => {
    const parsed = validateFamilySchema.safeParse(request.body ?? {})
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    const result = await services.productionUnitConversion.validateFamily(parsed.data.unitA, parsed.data.unitB)
    return { data: { valid: result.valid, family: result.family ?? false, error: result.error } }
  })
}

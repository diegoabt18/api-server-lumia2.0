import { AppError } from '../../../common/errors/app.error.js'
import type { UnitRepository } from '../infrastructure/unit.repository.js'
import type { UnitEquivalenceRepository } from '../infrastructure/unit-equivalence.repository.js'
import type { UnitConversionService } from './unit-conversion.service.js'

export class EquivalenceService {
  constructor(
    private readonly equivalences: UnitEquivalenceRepository,
    private readonly units: UnitRepository,
    private readonly conversion?: UnitConversionService,
  ) {}

  async list(query: Record<string, unknown>) {
    const activeOnly = query.activeOnly === true || query.activeOnly === 'true'
    const data = await this.equivalences.list(activeOnly)
    return { data }
  }

  async get(id: string) {
    const item = await this.equivalences.getById(id)
    if (!item) throw AppError.notFound('Equivalencia no encontrada')
    return { success: true as const, data: item }
  }

  async create(input: Record<string, unknown>) {
    const fromUnitId = String(input.fromUnitId ?? '')
    const toUnitId = String(input.toUnitId ?? '')
    const fromUnit = await this.units.getById(fromUnitId)
    if (!fromUnit) throw AppError.badRequest(`Unidad origen "${fromUnitId}" no encontrada`)
    const toUnit = await this.units.getById(toUnitId)
    if (!toUnit) throw AppError.badRequest(`Unidad destino "${toUnitId}" no encontrada`)

    const data = await this.equivalences.create({
      fromUnitId,
      toUnitId,
      factor: Number(input.factor),
      description: input.description ? String(input.description) : undefined,
      active: input.active !== false,
    })
    this.conversion?.invalidateCache()
    return { success: true as const, data }
  }

  async update(id: string, patch: Record<string, unknown>) {
    const updated = await this.equivalences.update(id, patch)
    if (!updated) throw AppError.notFound('Equivalencia no encontrada')
    this.conversion?.invalidateCache()
    return { success: true as const, data: updated }
  }

  async delete(id: string) {
    const ok = await this.equivalences.deleteEquivalence(id)
    if (!ok) throw AppError.notFound('Equivalencia no encontrada')
    this.conversion?.invalidateCache()
    return { success: true as const }
  }
}

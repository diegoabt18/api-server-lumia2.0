import { AppError } from '../../../common/errors/app.error.js'
import type { UnitRepository } from '../infrastructure/unit.repository.js'

export class UnitService {
  constructor(private readonly units: UnitRepository) {}

  async list(query: Record<string, unknown>) {
    const search = typeof query.search === 'string' ? query.search : undefined
    const family = typeof query.family === 'string' ? query.family : undefined
    const data = await this.units.list(search, family)
    return { data }
  }

  async get(id: string) {
    const unit = await this.units.getById(id)
    if (!unit) throw AppError.notFound('Unidad no encontrada')
    return { success: true as const, data: unit }
  }

  async create(input: Record<string, unknown>) {
    try {
      const unit = await this.units.create(input as never)
      return { success: true as const, data: unit }
    } catch (e: unknown) {
      if ((e as { code?: number }).code === 11000) throw AppError.conflict('Ya existe una unidad con esa abreviatura')
      throw e
    }
  }

  async update(id: string, patch: Record<string, unknown>) {
    try {
      const updated = await this.units.update(id, patch)
      if (!updated) throw AppError.notFound('Unidad no encontrada')
      return { success: true as const, data: updated }
    } catch (e: unknown) {
      if ((e as { code?: number }).code === 11000) throw AppError.conflict('Ya existe una unidad con esa abreviatura')
      throw e
    }
  }

  async delete(id: string) {
    const ok = await this.units.deleteUnit(id)
    if (!ok) throw AppError.notFound('Unidad no encontrada')
    return { success: true as const }
  }
}

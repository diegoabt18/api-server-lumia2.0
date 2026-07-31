import { AppError } from '../../../common/errors/app.error.js'
import type { IndirectCostAllocation } from '../domain/global-indirect-cost.entity.js'
import type { IndirectCostRepository } from '../infrastructure/indirect-cost.repository.js'

export class IndirectCostService {
  constructor(private readonly indirectCosts: IndirectCostRepository) {}

  async list(query: Record<string, unknown>) {
    const activeOnly = query.activeOnly === true || query.activeOnly === 'true'
    const data = await this.indirectCosts.list(activeOnly)
    return { data }
  }

  async create(input: Record<string, unknown>) {
    const now = new Date()
    const data = await this.indirectCosts.create({
      name: String(input.name),
      allocation_type: input.allocationType as IndirectCostAllocation,
      value: Number(input.value),
      active: input.active !== false,
      notes: input.notes ? String(input.notes) : undefined,
      created_at: now,
      updated_at: now,
    })
    return { success: true as const, data }
  }

  async update(id: string, patch: Record<string, unknown>) {
    const updated = await this.indirectCosts.update(id, patch)
    if (!updated) throw AppError.notFound('Costo indirecto no encontrado')
    return { success: true as const, data: updated }
  }

  async delete(id: string) {
    const ok = await this.indirectCosts.deleteCost(id)
    if (!ok) throw AppError.notFound('Costo indirecto no encontrado')
    return { success: true as const }
  }
}

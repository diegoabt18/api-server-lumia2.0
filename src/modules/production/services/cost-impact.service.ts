import { ObjectId } from 'mongodb'
import { AppError } from '../../../common/errors/app.error.js'
import { resolvePagingQuery } from '../../../common/utils/pagination.js'
import { resolveCostImpactPatch } from '../domain/cost-impact.entity.js'
import type { ImpactStatus } from '../domain/cost-impact.entity.js'
import type { CostImpactRepository } from '../infrastructure/cost-impact.repository.js'
import type { ProductionAuditRepository } from '../infrastructure/production-audit.repository.js'

export class CostImpactService {
  constructor(
    private readonly impacts: CostImpactRepository,
    private readonly audit: ProductionAuditRepository,
  ) {}

  async list(query: Record<string, unknown>) {
    const { page, limit, skip } = resolvePagingQuery(query, { defaultLimit: 20, maxLimit: 100 })
    const status = typeof query.status === 'string' ? (query.status as ImpactStatus) : undefined
    const result = await this.impacts.list({ status, limit, offset: skip })
    return {
      data: result.items,
      meta: {
        total: result.total,
        page,
        pageSize: limit,
        totalPages: Math.ceil(result.total / limit) || 1,
      },
    }
  }

  async summary() {
    const pendingImpacts = await this.impacts.getPendingCount()
    return { data: { pendingImpacts } }
  }

  async resolve(id: string, userId: string) {
    const impact = await this.impacts.getById(id)
    if (!impact) throw AppError.notFound('Impacto no encontrado')
    const updated = await this.impacts.update(id, resolveCostImpactPatch())
    if (!updated) throw AppError.notFound('Impacto no encontrado')
    await this.audit.insert({
      event_type: 'impact_resolved',
      entity_type: 'cost_impact',
      entity_id: id,
      description: `Impacto resuelto: ${impact.changeDescription}`,
      performed_by: ObjectId.isValid(userId) ? new ObjectId(userId) : userId,
      created_at: new Date(),
    })
    return { data: updated }
  }
}

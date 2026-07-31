import type { Db, Filter } from 'mongodb'
import { ObjectId } from 'mongodb'
import { BaseRepository, getCollection } from '../../../database/repositories/base.repository.js'
import {
  toCostImpactDomain,
  type CostImpactDomain,
  type CostImpactEntity,
  type ImpactStatus,
} from '../domain/cost-impact.entity.js'

export class CostImpactRepository extends BaseRepository<CostImpactEntity> {
  constructor(db: Db) {
    super(getCollection<CostImpactEntity>(db, 'cost_impacts'))
  }

  async ensureIndexes(): Promise<void> {
    await super.ensureIndexes([
      { key: { status: 1, detected_at: -1 } },
      { key: { material_id: 1 } },
    ])
  }

  async list(options: {
    status?: ImpactStatus
    limit: number
    offset: number
  }): Promise<{ items: CostImpactDomain[]; total: number }> {
    const filter: Filter<CostImpactEntity> = options.status
      ? ({ status: options.status } as Filter<CostImpactEntity>)
      : {}
    const [docs, total] = await Promise.all([
      this.findMany(filter, { skip: options.offset, limit: options.limit, sort: { detected_at: -1 } }),
      this.count(filter),
    ])
    return { items: docs.map(toCostImpactDomain), total }
  }

  async getById(id: string): Promise<CostImpactDomain | null> {
    const doc = await this.findById(id)
    return doc ? toCostImpactDomain(doc) : null
  }

  async update(id: string, patch: Partial<CostImpactEntity>): Promise<CostImpactDomain | null> {
    if (!ObjectId.isValid(id)) return null
    await this.collection.updateOne({ _id: new ObjectId(id) } as Filter<CostImpactEntity>, {
      $set: { ...patch, updated_at: new Date() },
    })
    return this.getById(id)
  }

  async getPendingCount(): Promise<number> {
    return this.count({ status: 'detected' } as Filter<CostImpactEntity>)
  }
}

import type { Db, Filter } from 'mongodb'
import { ObjectId } from 'mongodb'
import { BaseRepository, getCollection } from '../../../database/repositories/base.repository.js'
import {
  toGlobalIndirectCostDomain,
  type GlobalIndirectCostDomain,
  type GlobalIndirectCostEntity,
} from '../domain/global-indirect-cost.entity.js'

export class IndirectCostRepository extends BaseRepository<GlobalIndirectCostEntity> {
  constructor(db: Db) {
    super(getCollection<GlobalIndirectCostEntity>(db, 'indirect_costs'))
  }

  async ensureIndexes(): Promise<void> {
    await super.ensureIndexes([{ key: { name: 1 } }, { key: { active: 1 } }])
  }

  async list(activeOnly?: boolean): Promise<GlobalIndirectCostDomain[]> {
    const filter: Filter<GlobalIndirectCostEntity> = activeOnly
      ? ({ active: true } as Filter<GlobalIndirectCostEntity>)
      : {}
    const docs = await this.findMany(filter, { sort: { name: 1 } })
    return docs.map(toGlobalIndirectCostDomain)
  }

  async getById(id: string): Promise<GlobalIndirectCostDomain | null> {
    const doc = await this.findById(id)
    return doc ? toGlobalIndirectCostDomain(doc) : null
  }

  async create(entity: Omit<GlobalIndirectCostEntity, '_id'>): Promise<GlobalIndirectCostDomain> {
    const id = await this.insertOne(entity as never)
    const doc = await this.findById(id)
    if (!doc) throw new Error('Failed to create indirect cost')
    return toGlobalIndirectCostDomain(doc)
  }

  async update(id: string, patch: Record<string, unknown>): Promise<GlobalIndirectCostDomain | null> {
    if (!ObjectId.isValid(id)) return null
    const $set: Record<string, unknown> = { updated_at: new Date() }
    if (patch.name !== undefined) $set.name = patch.name
    if (patch.allocationType !== undefined) $set.allocation_type = patch.allocationType
    if (patch.value !== undefined) $set.value = patch.value
    if (patch.active !== undefined) $set.active = patch.active
    if (patch.notes !== undefined) $set.notes = patch.notes
    await this.collection.updateOne({ _id: new ObjectId(id) } as Filter<GlobalIndirectCostEntity>, { $set })
    return this.getById(id)
  }

  async deleteCost(id: string): Promise<boolean> {
    return this.deleteById(id)
  }
}

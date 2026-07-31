import type { Db, Filter } from 'mongodb'
import { ObjectId } from 'mongodb'
import { BaseRepository, getCollection } from '../../../database/repositories/base.repository.js'
import { toServiceCostDomain, type ServiceCostDomain, type ServiceCostEntity } from '../domain/service-cost.entity.js'

export class ServiceCostRepository extends BaseRepository<ServiceCostEntity> {
  constructor(db: Db) {
    super(getCollection<ServiceCostEntity>(db, 'service_costs'))
  }

  async ensureIndexes(): Promise<void> {
    await super.ensureIndexes([{ key: { recipe_id: 1 }, unique: true }])
  }

  async getByRecipeId(recipeId: string): Promise<ServiceCostDomain | null> {
    if (!ObjectId.isValid(recipeId)) return null
    const doc = await this.findOne({ recipe_id: new ObjectId(recipeId) } as Filter<ServiceCostEntity>)
    return doc ? toServiceCostDomain(doc) : null
  }

  async upsert(recipeId: string, entity: Omit<ServiceCostEntity, '_id'>): Promise<ServiceCostDomain> {
    const $set = { ...entity, recipe_id: new ObjectId(recipeId), updated_at: new Date() }
    await this.collection.updateOne(
      { recipe_id: new ObjectId(recipeId) } as Filter<ServiceCostEntity>,
      { $set },
      { upsert: true },
    )
    const doc = await this.findOne({ recipe_id: new ObjectId(recipeId) } as Filter<ServiceCostEntity>)
    if (!doc) throw new Error('Failed to upsert service cost')
    return toServiceCostDomain(doc)
  }
}

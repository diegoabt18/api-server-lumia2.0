import type { Db, Filter } from 'mongodb'
import { ObjectId } from 'mongodb'
import { BaseRepository, getCollection } from '../../../database/repositories/base.repository.js'
import { toLaborCostDomain, type LaborCostDomain, type LaborCostEntity } from '../domain/labor-cost.entity.js'

export class LaborCostRepository extends BaseRepository<LaborCostEntity> {
  constructor(db: Db) {
    super(getCollection<LaborCostEntity>(db, 'labor_costs'))
  }

  async ensureIndexes(): Promise<void> {
    await super.ensureIndexes([{ key: { recipe_id: 1 }, unique: true }])
  }

  async getByRecipeId(recipeId: string): Promise<LaborCostDomain | null> {
    if (!ObjectId.isValid(recipeId)) return null
    const doc = await this.findOne({ recipe_id: new ObjectId(recipeId) } as Filter<LaborCostEntity>)
    return doc ? toLaborCostDomain(doc) : null
  }

  async upsert(recipeId: string, entity: Omit<LaborCostEntity, '_id'>): Promise<LaborCostDomain> {
    const $set = { ...entity, recipe_id: new ObjectId(recipeId), updated_at: new Date() }
    await this.collection.updateOne(
      { recipe_id: new ObjectId(recipeId) } as Filter<LaborCostEntity>,
      { $set },
      { upsert: true },
    )
    const doc = await this.findOne({ recipe_id: new ObjectId(recipeId) } as Filter<LaborCostEntity>)
    if (!doc) throw new Error('Failed to upsert labor cost')
    return toLaborCostDomain(doc)
  }
}

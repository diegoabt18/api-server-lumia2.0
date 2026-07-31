import type { Db, Filter } from 'mongodb'
import { ObjectId } from 'mongodb'
import { BaseRepository, getCollection } from '../../../database/repositories/base.repository.js'
import { toPackagingCostDomain, type PackagingCostDomain, type PackagingCostEntity } from '../domain/packaging-cost.entity.js'

export class PackagingCostRepository extends BaseRepository<PackagingCostEntity> {
  constructor(db: Db) {
    super(getCollection<PackagingCostEntity>(db, 'packaging_costs'))
  }

  async ensureIndexes(): Promise<void> {
    await super.ensureIndexes([{ key: { recipe_id: 1 }, unique: true }])
  }

  async getByRecipeId(recipeId: string): Promise<PackagingCostDomain | null> {
    if (!ObjectId.isValid(recipeId)) return null
    const doc = await this.findOne({ recipe_id: new ObjectId(recipeId) } as Filter<PackagingCostEntity>)
    return doc ? toPackagingCostDomain(doc) : null
  }

  async upsert(recipeId: string, entity: Omit<PackagingCostEntity, '_id'>): Promise<PackagingCostDomain> {
    const $set = { ...entity, recipe_id: new ObjectId(recipeId), updated_at: new Date() }
    await this.collection.updateOne(
      { recipe_id: new ObjectId(recipeId) } as Filter<PackagingCostEntity>,
      { $set },
      { upsert: true },
    )
    const doc = await this.findOne({ recipe_id: new ObjectId(recipeId) } as Filter<PackagingCostEntity>)
    if (!doc) throw new Error('Failed to upsert packaging cost')
    return toPackagingCostDomain(doc)
  }
}

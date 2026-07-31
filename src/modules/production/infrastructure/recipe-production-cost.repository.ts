import type { Db, Filter } from 'mongodb'
import { ObjectId } from 'mongodb'
import { BaseRepository, getCollection } from '../../../database/repositories/base.repository.js'
import {
  toRecipeProductionCostDomain,
  type RecipeProductionCostDomain,
  type RecipeProductionCostEntity,
} from '../domain/recipe-production-cost.entity.js'

export class RecipeProductionCostRepository extends BaseRepository<RecipeProductionCostEntity> {
  constructor(db: Db) {
    super(getCollection<RecipeProductionCostEntity>(db, 'production_costs'))
  }

  async ensureIndexes(): Promise<void> {
    await super.ensureIndexes([{ key: { recipe_id: 1 }, unique: true }])
  }

  async getByRecipeId(recipeId: string): Promise<RecipeProductionCostDomain | null> {
    if (!ObjectId.isValid(recipeId)) return null
    const doc = await this.findOne({ recipe_id: new ObjectId(recipeId) } as Filter<RecipeProductionCostEntity>)
    return doc ? toRecipeProductionCostDomain(doc) : null
  }

  async upsert(recipeId: string, entity: Omit<RecipeProductionCostEntity, '_id'>): Promise<RecipeProductionCostDomain> {
    const $set = { ...entity, recipe_id: new ObjectId(recipeId), updated_at: new Date() }
    await this.collection.updateOne(
      { recipe_id: new ObjectId(recipeId) } as Filter<RecipeProductionCostEntity>,
      { $set },
      { upsert: true },
    )
    const doc = await this.findOne({ recipe_id: new ObjectId(recipeId) } as Filter<RecipeProductionCostEntity>)
    if (!doc) throw new Error('Failed to upsert production cost')
    return toRecipeProductionCostDomain(doc)
  }
}

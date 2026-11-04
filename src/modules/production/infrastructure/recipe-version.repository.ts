import type { Db, Filter } from 'mongodb'
import { ObjectId } from 'mongodb'
import { BaseRepository, getCollection } from '../../../database/repositories/base.repository.js'
import { toRecipeVersionDomain, type RecipeVersionDomain, type RecipeVersionEntity } from '../domain/recipe-version.entity.js'

export class RecipeVersionRepository extends BaseRepository<RecipeVersionEntity> {
  constructor(db: Db) {
    super(getCollection<RecipeVersionEntity>(db, 'recipe_versions'))
  }

  async ensureIndexes(): Promise<void> {
    await super.ensureIndexes([{ key: { recipe_id: 1, version: -1 } }])
  }

  async getByRecipeId(recipeId: string): Promise<RecipeVersionDomain[]> {
    if (!ObjectId.isValid(recipeId)) return []
    const docs = await this.findMany({ recipe_id: new ObjectId(recipeId) } as Filter<RecipeVersionEntity>, {
      sort: { version: -1 },
    })
    return docs.map(toRecipeVersionDomain)
  }

  async createSnapshot(input: {
    recipeId: string
    version: number
    lines: unknown[]
    indirectCosts: unknown[]
    materialsCost: number
    indirectCost: number
    totalCost: number
    changesDescription: string
    changedBy: string
  }): Promise<void> {
    if (!ObjectId.isValid(input.recipeId)) return
    const entity: RecipeVersionEntity = {
      recipe_id: new ObjectId(input.recipeId),
      version: input.version,
      lines: input.lines,
      indirect_costs: input.indirectCosts,
      materials_cost: input.materialsCost,
      indirect_cost: input.indirectCost,
      total_cost: input.totalCost,
      changes_description: input.changesDescription,
      changed_by: ObjectId.isValid(input.changedBy) ? new ObjectId(input.changedBy) : input.changedBy,
      created_at: new Date(),
    }
    await this.insertOne(entity as never)
  }
}

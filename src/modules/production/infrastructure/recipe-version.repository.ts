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
}

import type { Db, Filter } from 'mongodb'
import { ObjectId } from 'mongodb'
import { BaseRepository, getCollection } from '../../../database/repositories/base.repository.js'
import { toCostSheetDomain, type CostSheetDomain, type CostSheetEntity } from '../domain/cost-sheet.entity.js'

export class CostSheetRepository extends BaseRepository<CostSheetEntity> {
  constructor(db: Db) {
    super(getCollection<CostSheetEntity>(db, 'cost_sheets_v2'))
  }

  async ensureIndexes(): Promise<void> {
    await super.ensureIndexes([
      { key: { recipe_id: 1, calculated_at: -1 } },
      { key: { variant_sku: 1 } },
    ])
  }

  async getByRecipeId(recipeId: string, limit = 20): Promise<CostSheetDomain[]> {
    if (!ObjectId.isValid(recipeId)) return []
    const docs = await this.findMany({ recipe_id: new ObjectId(recipeId) } as Filter<CostSheetEntity>, {
      sort: { calculated_at: -1 },
      limit,
    })
    return docs.map(toCostSheetDomain)
  }
}

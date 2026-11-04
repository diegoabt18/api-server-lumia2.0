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

  /** Última versión de receta publicada por SKU (cost sheet más reciente). */
  async getLatestRecipeVersionsBySkus(skus: string[]): Promise<Map<string, number>> {
    const unique = [...new Set(skus.filter(Boolean))]
    if (!unique.length) return new Map()
    const rows = await this.collection
      .aggregate<{ _id: string; recipe_version: number }>([
        { $match: { variant_sku: { $in: unique } } },
        { $sort: { calculated_at: -1 } },
        {
          $group: {
            _id: '$variant_sku',
            recipe_version: { $first: '$recipe_version' },
          },
        },
      ])
      .toArray()
    return new Map(
      rows
        .filter((r) => r.recipe_version != null)
        .map((r) => [r._id, Number(r.recipe_version)]),
    )
  }

  async getLatestByVariantSku(variantSku: string): Promise<CostSheetDomain | null> {
    const docs = await this.findMany({ variant_sku: variantSku } as Filter<CostSheetEntity>, {
      sort: { calculated_at: -1 },
      limit: 1,
    })
    return docs[0] ? toCostSheetDomain(docs[0]) : null
  }

  async createForVariant(input: {
    recipeId: string
    recipeVersion: number
    variantSku: string
    productSlug: string
    materialsCost: number
    indirectCost: number
    totalCost: number
    suggestedPrice?: number
    marginPercentage?: number
    currency: string
    calculatedBy: string
  }): Promise<CostSheetDomain> {
    const entity: CostSheetEntity = {
      recipe_id: ObjectId.isValid(input.recipeId) ? new ObjectId(input.recipeId) : input.recipeId,
      recipe_version: input.recipeVersion,
      variant_sku: input.variantSku,
      product_slug: input.productSlug,
      materials_cost: input.materialsCost,
      indirect_cost: input.indirectCost,
      total_cost: input.totalCost,
      total_cost_with_waste: input.totalCost,
      suggested_price: input.suggestedPrice,
      margin_percentage: input.marginPercentage,
      currency: input.currency,
      calculated_at: new Date(),
      calculated_by: ObjectId.isValid(input.calculatedBy)
        ? new ObjectId(input.calculatedBy)
        : input.calculatedBy,
    }
    const id = await this.insertOne(entity as never)
    const created = await this.findById(id)
    if (!created) throw new Error('Failed to create cost sheet')
    return toCostSheetDomain(created)
  }
}

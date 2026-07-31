import type { Db, Filter } from 'mongodb'
import { ObjectId } from 'mongodb'
import { BaseRepository, getCollection } from '../../../database/repositories/base.repository.js'
import { toRecipeDomain, type RecipeDomain, type RecipeEntity, type RecipeLineEntity } from '../domain/recipe.entity.js'

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function buildRecipeFilter(search?: string, productSlug?: string, outdatedOnly?: boolean): Filter<RecipeEntity> {
  const parts: Filter<RecipeEntity>[] = []
  if (search?.trim()) {
    const term = escapeRegex(search.trim())
    parts.push({
      $or: [
        { product_slug: { $regex: term, $options: 'i' } },
        { product_name: { $regex: term, $options: 'i' } },
        { name: { $regex: term, $options: 'i' } },
      ],
    } as Filter<RecipeEntity>)
  }
  if (productSlug) parts.push({ product_slug: productSlug } as Filter<RecipeEntity>)
  if (outdatedOnly) parts.push({ costs_outdated: true, is_active: true } as Filter<RecipeEntity>)
  if (!parts.length) return {}
  if (parts.length === 1) return parts[0]!
  return { $and: parts } as Filter<RecipeEntity>
}

export class RecipeRepository extends BaseRepository<RecipeEntity> {
  constructor(db: Db) {
    super(getCollection<RecipeEntity>(db, 'recipes'))
  }

  async ensureIndexes(): Promise<void> {
    await super.ensureIndexes([
      { key: { product_slug: 1, is_active: 1 } },
      { key: { 'lines.material_id': 1 } },
    ])
  }

  async countAll(search?: string, productSlug?: string, outdatedOnly?: boolean): Promise<number> {
    return this.count(buildRecipeFilter(search, productSlug, outdatedOnly))
  }

  async list(
    limit: number,
    offset: number,
    search?: string,
    productSlug?: string,
    outdatedOnly?: boolean,
  ): Promise<RecipeDomain[]> {
    const docs = await this.findMany(buildRecipeFilter(search, productSlug, outdatedOnly), {
      skip: offset,
      limit,
      sort: { updated_at: -1 },
    })
    return docs.map(toRecipeDomain)
  }

  async getById(id: string): Promise<RecipeDomain | null> {
    const doc = await this.findById(id)
    return doc ? toRecipeDomain(doc) : null
  }

  async create(entity: Omit<RecipeEntity, '_id'>): Promise<RecipeDomain> {
    const id = await this.insertOne(entity as never)
    const doc = await this.findById(id)
    if (!doc) throw new Error('Failed to create recipe')
    return toRecipeDomain(doc)
  }

  async update(id: string, patch: Record<string, unknown>): Promise<RecipeDomain | null> {
    if (!ObjectId.isValid(id)) return null
    const $set: Record<string, unknown> = { updated_at: new Date() }

    if (patch.name !== undefined) $set.name = patch.name
    if (patch.product_slug !== undefined) $set.product_slug = patch.product_slug
    if (patch.product_name !== undefined) $set.product_name = patch.product_name
    if (patch.variant_sku !== undefined) $set.variant_sku = patch.variant_sku
    if (patch.is_active !== undefined) $set.is_active = patch.is_active
    if (patch.lines !== undefined) $set.lines = patch.lines
    if (patch.indirect_costs !== undefined) $set.indirect_costs = patch.indirect_costs
    if (patch.margin_percentage !== undefined) $set.margin_percentage = patch.margin_percentage
    if (patch.pricing_mode !== undefined) $set.pricing_mode = patch.pricing_mode
    if (patch.manual_price !== undefined) $set.manual_price = patch.manual_price
    if (patch.suggested_price !== undefined) $set.suggested_price = patch.suggested_price
    if (patch.actual_price !== undefined) $set.actual_price = patch.actual_price
    if (patch.cached_materials_cost !== undefined) $set.cached_materials_cost = patch.cached_materials_cost
    if (patch.cached_indirect_cost !== undefined) $set.cached_indirect_cost = patch.cached_indirect_cost
    if (patch.cached_total_cost !== undefined) $set.cached_total_cost = patch.cached_total_cost
    if (patch.costs_outdated !== undefined) $set.costs_outdated = patch.costs_outdated
    if (patch.costs_last_calculated_at !== undefined) $set.costs_last_calculated_at = patch.costs_last_calculated_at
    if (patch.costs_last_calculated_by !== undefined) $set.costs_last_calculated_by = patch.costs_last_calculated_by
    if (patch.version !== undefined) $set.version = patch.version

    await this.collection.updateOne({ _id: new ObjectId(id) } as Filter<RecipeEntity>, { $set })
    return this.getById(id)
  }

  async deleteRecipe(id: string): Promise<boolean> {
    return this.deleteById(id)
  }

  async markOutdatedByMaterialId(materialId: string): Promise<void> {
    if (!ObjectId.isValid(materialId)) return
    await this.collection.updateMany(
      { 'lines.material_id': new ObjectId(materialId), is_active: true } as Filter<RecipeEntity>,
      { $set: { costs_outdated: true, updated_at: new Date() } },
    )
  }

  async countUsingMaterial(materialId: string): Promise<number> {
    if (!ObjectId.isValid(materialId)) return 0
    return this.count({ 'lines.material_id': new ObjectId(materialId) } as Filter<RecipeEntity>)
  }

  async getOutdatedProductSlugs(): Promise<string[]> {
    const docs = await this.findMany({ costs_outdated: true, is_active: true } as Filter<RecipeEntity>)
    return [...new Set(docs.map((d) => d.product_slug))]
  }

  buildLineEntities(
    lines: {
      materialId?: string
      materialName: string
      materialCode?: string
      materialPurchaseUnit?: string
      rolloMeters?: number
      unit: string
      quantity: number
    }[],
  ): RecipeLineEntity[] {
    return lines.map((l) => ({
      material_id: l.materialId && ObjectId.isValid(l.materialId) ? new ObjectId(l.materialId) : l.materialId,
      material_name: l.materialName,
      material_code: l.materialCode,
      material_purchase_unit: l.materialPurchaseUnit,
      rollo_meters: l.rolloMeters,
      unit: l.unit as RecipeLineEntity['unit'],
      quantity: l.quantity,
      unit_cost: 0,
      partial_cost: 0,
    }))
  }
}

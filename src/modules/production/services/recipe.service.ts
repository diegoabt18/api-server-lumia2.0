import { ObjectId } from 'mongodb'
import { AppError } from '../../../common/errors/app.error.js'
import { resolvePagingQuery } from '../../../common/utils/pagination.js'
import type { MaterialRepository } from '../infrastructure/material.repository.js'
import type { ProductionAuditRepository } from '../infrastructure/production-audit.repository.js'
import type { RecipeRepository } from '../infrastructure/recipe.repository.js'
import type { CostingService } from './costing.service.js'

export class RecipeService {
  constructor(
    private readonly recipes: RecipeRepository,
    private readonly materials: MaterialRepository,
    private readonly audit: ProductionAuditRepository,
    private readonly costing: CostingService,
  ) {}

  async list(query: Record<string, unknown>) {
    const { page, limit, skip, search } = resolvePagingQuery(query, { defaultLimit: 20, maxLimit: 100 })
    const productSlug = typeof query.productSlug === 'string' ? query.productSlug : undefined
    const outdatedOnly = query.outdatedOnly === true || query.outdatedOnly === 'true'
    const [items, total] = await Promise.all([
      this.recipes.list(limit, skip, search || undefined, productSlug, outdatedOnly),
      this.recipes.countAll(search || undefined, productSlug, outdatedOnly),
    ])
    return {
      data: items,
      meta: { total, page, pageSize: limit, totalPages: Math.ceil(total / limit) || 1 },
    }
  }

  async get(id: string) {
    const recipe = await this.recipes.getById(id)
    if (!recipe) throw AppError.notFound('Receta no encontrada')
    return { success: true as const, data: recipe }
  }

  async create(input: Record<string, unknown>, userId: string) {
    const lines = (input.lines as Array<Record<string, unknown>>) ?? []
    if (!lines.length) throw AppError.badRequest('Debe tener al menos un material')

    const enrichedLines = await this.enrichLines(lines)
    const indirectCosts = (input.indirectCosts as Array<Record<string, unknown>>) ?? []

    const entity = {
      name: String(input.name),
      product_slug: String(input.productSlug),
      product_name: input.productName ? String(input.productName) : undefined,
      variant_sku: input.variantSku ? String(input.variantSku) : undefined,
      version: 1,
      is_active: true,
      lines: this.recipes.buildLineEntities(enrichedLines),
      indirect_costs: indirectCosts.map((ic) => ({
        name: String(ic.name),
        type: ic.type as 'fixed' | 'percentage',
        value: Number(ic.value),
        optional: ic.optional !== false,
      })),
      cached_materials_cost: 0,
      cached_indirect_cost: 0,
      cached_total_cost: 0,
      currency: 'COP',
      margin_percentage: input.marginPercentage != null ? Number(input.marginPercentage) : undefined,
      pricing_mode: (input.pricingMode as 'auto_margin' | 'fixed_margin' | 'manual') ?? 'auto_margin',
      manual_price: input.manualPrice != null ? Number(input.manualPrice) : undefined,
      costs_outdated: true,
      created_at: new Date(),
      updated_at: new Date(),
    }

    const recipe = await this.recipes.create(entity)
    await this.audit.insert({
      event_type: 'recipe_created',
      entity_type: 'recipe',
      entity_id: recipe.id,
      description: `Receta creada: ${recipe.name}`,
      new_value: recipe,
      performed_by: ObjectId.isValid(userId) ? new ObjectId(userId) : userId,
      created_at: new Date(),
    })
    return { success: true as const, data: recipe }
  }

  async update(id: string, patch: Record<string, unknown>, userId: string) {
    const prev = await this.recipes.getById(id)
    if (!prev) throw AppError.notFound('Receta no encontrada')

    const updatePatch: Record<string, unknown> = {}
    if (patch.name !== undefined) updatePatch.name = patch.name
    if (patch.productSlug !== undefined) updatePatch.product_slug = patch.productSlug
    if (patch.productName !== undefined) updatePatch.product_name = patch.productName
    if (patch.variantSku !== undefined) updatePatch.variant_sku = patch.variantSku
    if (patch.active !== undefined) updatePatch.is_active = patch.active
    if (patch.marginPercentage !== undefined) updatePatch.margin_percentage = patch.marginPercentage
    if (patch.pricingMode !== undefined) updatePatch.pricing_mode = patch.pricingMode
    if (patch.manualPrice !== undefined) updatePatch.manual_price = patch.manualPrice
    if (patch.suggestedPrice !== undefined) updatePatch.suggested_price = patch.suggestedPrice
    if (patch.actualPrice !== undefined) updatePatch.actual_price = patch.actualPrice

    if (patch.lines) {
      const enriched = await this.enrichLines(patch.lines as Array<Record<string, unknown>>)
      updatePatch.lines = this.recipes.buildLineEntities(enriched)
      updatePatch.costs_outdated = true
    }
    if (patch.indirectCosts) {
      updatePatch.indirect_costs = (patch.indirectCosts as Array<Record<string, unknown>>).map((ic) => ({
        name: String(ic.name),
        type: ic.type as 'fixed' | 'percentage',
        value: Number(ic.value),
        optional: ic.optional !== false,
      }))
      updatePatch.costs_outdated = true
    }

    const updated = await this.recipes.update(id, updatePatch)
    if (!updated) throw AppError.notFound('Receta no encontrada')

    await this.audit.insert({
      event_type: 'recipe_modified',
      entity_type: 'recipe',
      entity_id: id,
      description: patch.changesDescription
        ? String(patch.changesDescription)
        : `Receta modificada: ${updated.name}`,
      previous_value: prev,
      new_value: updated,
      performed_by: ObjectId.isValid(userId) ? new ObjectId(userId) : userId,
      created_at: new Date(),
    })
    return { success: true as const, data: updated }
  }

  async delete(id: string, userId: string) {
    const recipe = await this.recipes.getById(id)
    if (!recipe) throw AppError.notFound('Receta no encontrada')
    const ok = await this.recipes.deleteRecipe(id)
    if (!ok) throw AppError.notFound('Receta no encontrada')
    await this.audit.insert({
      event_type: 'recipe_deleted',
      entity_type: 'recipe',
      entity_id: id,
      description: `Receta eliminada: ${recipe.name}`,
      previous_value: recipe,
      performed_by: ObjectId.isValid(userId) ? new ObjectId(userId) : userId,
      created_at: new Date(),
    })
    return { success: true as const }
  }

  async calculateCost(id: string, userId: string) {
    try {
      return await this.costing.calculateRecipeCost(id, userId)
    } catch (e) {
      throw AppError.badRequest(e instanceof Error ? e.message : 'Error al calcular costo')
    }
  }

  private async enrichLines(lines: Array<Record<string, unknown>>) {
    const materialIds = lines.map((l) => String(l.materialId ?? '')).filter(Boolean)
    const materials = await this.materials.getByIds(materialIds)
    const map = new Map(materials.map((m) => [m.id, m]))

    return lines.map((l) => {
      const mat = l.materialId ? map.get(String(l.materialId)) : undefined
      return {
        materialId: l.materialId ? String(l.materialId) : undefined,
        materialName: mat?.name ?? String(l.materialName ?? ''),
        materialCode: mat?.code ?? (l.materialCode ? String(l.materialCode) : undefined),
        materialPurchaseUnit: mat?.purchaseUnit,
        rolloMeters: mat?.rollMeters ?? (l.rolloMeters != null ? Number(l.rolloMeters) : undefined),
        unit: String(l.unit),
        quantity: Number(l.quantity),
      }
    })
  }
}

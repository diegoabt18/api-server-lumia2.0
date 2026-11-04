import { ObjectId } from 'mongodb'
import { AppError } from '../../../common/errors/app.error.js'
import { resolvePagingQuery } from '../../../common/utils/pagination.js'
import { buildLaborCostEntity } from '../domain/labor-cost.entity.js'
import { buildPackagingCostEntity } from '../domain/packaging-cost.entity.js'
import { buildRecipeProductionCostEntity } from '../domain/recipe-production-cost.entity.js'
import { buildServiceCostEntity } from '../domain/service-cost.entity.js'
import type { CostSheetRepository } from '../infrastructure/cost-sheet.repository.js'
import type { LaborCostRepository } from '../infrastructure/labor-cost.repository.js'
import type { MaterialRepository } from '../infrastructure/material.repository.js'
import type { PackagingCostRepository } from '../infrastructure/packaging-cost.repository.js'
import type { PriceApprovalRepository } from '../infrastructure/price-approval.repository.js'
import type { ProductionAuditRepository } from '../infrastructure/production-audit.repository.js'
import type { RecipeProductionCostRepository } from '../infrastructure/recipe-production-cost.repository.js'
import type { RecipeRepository } from '../infrastructure/recipe.repository.js'
import type { RecipeVersionRepository } from '../infrastructure/recipe-version.repository.js'
import type { ServiceCostRepository } from '../infrastructure/service-cost.repository.js'
import type { ProductRepository } from '../../catalog/infrastructure/product.repository.js'
import {
  countVariantsNeedingRepost,
  resolveProductRepostStatus,
  resolveVariantRepostStatus,
  type ProductRepostStatus,
  type VariantRepostContext,
} from '../domain/repost-status.js'
import type { CostingService } from './costing.service.js'

export class RecipeService {
  constructor(
    private readonly recipes: RecipeRepository,
    private readonly materials: MaterialRepository,
    private readonly audit: ProductionAuditRepository,
    private readonly costing: CostingService,
    private readonly products?: ProductRepository,
    private readonly recipeVersions?: RecipeVersionRepository,
    private readonly costSheets?: CostSheetRepository,
    private readonly laborCosts?: LaborCostRepository,
    private readonly packagingCosts?: PackagingCostRepository,
    private readonly productionCosts?: RecipeProductionCostRepository,
    private readonly serviceCosts?: ServiceCostRepository,
    private readonly priceApprovals?: PriceApprovalRepository,
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
      margin_percentage: input.marginPercentage != null ? Number(input.marginPercentage) : 80,
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

    // Snapshot + bump de versión (mismo contrato que LUMIA embedded) para que el
    // listado de productos vea el cambio (vN → vN+1, costsOutdated, needs_repost).
    if (this.recipeVersions) {
      await this.recipeVersions.createSnapshot({
        recipeId: id,
        version: prev.version,
        lines: prev.lines,
        indirectCosts: prev.indirectCosts,
        materialsCost: prev.cachedMaterialsCost,
        indirectCost: prev.cachedIndirectCost,
        totalCost: prev.cachedTotalCost,
        changesDescription: patch.changesDescription
          ? String(patch.changesDescription)
          : 'Actualización de receta',
        changedBy: userId,
      })
    }

    const updatePatch: Record<string, unknown> = {
      version: prev.version + 1,
      costs_outdated: true,
    }
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
      const lineEntities = this.recipes.buildLineEntities(enriched)
      updatePatch.lines = lineEntities
      updatePatch.cached_materials_cost = lineEntities.reduce(
        (sum, l) => sum + (Number(l.partial_cost) || 0),
        0,
      )
    }
    if (patch.indirectCosts) {
      updatePatch.indirect_costs = (patch.indirectCosts as Array<Record<string, unknown>>).map((ic) => ({
        name: String(ic.name),
        type: ic.type as 'fixed' | 'percentage',
        value: Number(ic.value),
        optional: ic.optional !== false,
      }))
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

  async listProducts(query: Record<string, unknown>) {
    if (!this.products) throw AppError.internal('Catálogo no disponible')
    const { page, limit, skip, search } = resolvePagingQuery(query, { defaultLimit: 20, maxLimit: 100 })
    const repostStatusFilter =
      typeof query.repostStatus === 'string' && query.repostStatus.trim()
        ? (query.repostStatus.trim() as ProductRepostStatus)
        : undefined

    const { data: products, total: totalUnfiltered } = await this.products.listForProduction({
      search: search || undefined,
      limit,
      skip,
      fetchAllForFilter: !!repostStatusFilter,
    })

    const allRecipeIds = new Set<string>()
    for (const p of products) {
      if (p.productionRecipeId) allRecipeIds.add(p.productionRecipeId)
      for (const rid of p.variantRecipeIds ?? []) allRecipeIds.add(rid)
    }

    const recipes = await this.recipes.getByIds([...allRecipeIds])
    const recipeMap = new Map(recipes.map((r) => [r.id, r]))

    const allSkus = products.flatMap((p) => (p.variants ?? []).map((v) => v.sku)).filter(Boolean)
    const [sheetBySku, pendingBySku] = await Promise.all([
      this.costSheets?.getLatestRecipeVersionsBySkus(allSkus) ?? Promise.resolve(new Map<string, number>()),
      this.priceApprovals?.listPendingVariantSkus() ?? Promise.resolve(new Set<string>()),
    ])

    let data = products.map((p) => {
      const productRecipeId = p.productionRecipeId
      const linkedRecipeIds = [
        ...(productRecipeId ? [productRecipeId] : []),
        ...(p.variantRecipeIds ?? []),
      ]
      const uniqueLinked = [...new Set(linkedRecipeIds)]
      const primaryRecipeId = productRecipeId ?? uniqueLinked[0] ?? null
      const primaryRecipe = primaryRecipeId ? recipeMap.get(primaryRecipeId) : undefined
      const costsOutdated = uniqueLinked.some((rid) => recipeMap.get(rid)?.costsOutdated === true)

      const variantContexts: VariantRepostContext[] = (p.variants ?? []).map((v) => {
        const effectiveRecipeId = v.productionRecipeId ?? productRecipeId
        const effectiveRecipe = effectiveRecipeId ? recipeMap.get(effectiveRecipeId) : undefined
        return {
          sku: v.sku,
          hasRecipe: !!effectiveRecipeId,
          recipeId: effectiveRecipeId,
          recipeVersion: effectiveRecipe?.version ?? null,
          recipeCostsOutdated: effectiveRecipe?.costsOutdated ?? false,
          lastPublishedRecipeVersion: sheetBySku.get(v.sku) ?? null,
          costStatus: v.costStatus ?? null,
          hasPendingApproval: pendingBySku.has(v.sku),
        }
      })

      // Productos sin variantes pero con receta a nivel producto
      if (!variantContexts.length && productRecipeId) {
        variantContexts.push({
          sku: `${p.slug}::product`,
          hasRecipe: true,
          recipeId: productRecipeId,
          recipeVersion: primaryRecipe?.version ?? null,
          recipeCostsOutdated: primaryRecipe?.costsOutdated ?? false,
          lastPublishedRecipeVersion: null,
          costStatus: null,
          hasPendingApproval: false,
        })
      }

      const repostStatus: ProductRepostStatus = resolveProductRepostStatus(variantContexts)
      const variantsNeedingRepost = countVariantsNeedingRepost(variantContexts)
      const variantsPendingApproval = variantContexts.filter(
        (v) => resolveVariantRepostStatus(v) === 'pending_approval',
      ).length

      return {
        id: p.id,
        name: p.name,
        slug: p.slug,
        status: p.status,
        imagePath: p.imagePath,
        variantCount: p.variantCount,
        hasRecipe: p.hasRecipe,
        hasProductRecipe: p.hasProductRecipe,
        variantRecipeCount: p.variantRecipeCount,
        productionRecipeId: productRecipeId,
        recipeVersion: primaryRecipe?.version ?? null,
        recipeName: primaryRecipe?.name ?? null,
        costsOutdated,
        recipeActive: primaryRecipe?.isActive ?? false,
        repostStatus,
        variantsNeedingRepost,
        variantsPendingApproval,
        canRepostPrices: repostStatus === 'needs_repost' || repostStatus === 'mixed',
      }
    })

    if (repostStatusFilter) {
      data = data.filter((p) => p.repostStatus === repostStatusFilter)
    }

    const total = repostStatusFilter ? data.length : totalUnfiltered
    const paginatedData = repostStatusFilter ? data.slice(skip, skip + limit) : data

    return {
      data: paginatedData,
      meta: {
        total,
        page,
        pageSize: limit,
        totalPages: Math.ceil(total / limit) || 1,
        needsRepostCount: data.filter((p) => p.canRepostPrices).length,
      },
    }
  }

  async recalculateAll(userId: string) {
    return this.costing.recalculateAll(userId)
  }

  async getVersions(id: string) {
    if (!this.recipeVersions) return { data: [] }
    await this.ensureRecipeExists(id)
    const data = await this.recipeVersions.getByRecipeId(id)
    return { data }
  }

  async getAssociatedProducts(id: string) {
    if (!this.products) throw AppError.internal('Catálogo no disponible')
    const recipe = await this.recipes.getById(id)
    if (!recipe) throw AppError.notFound('Receta no encontrada')
    const associated = await this.products.findAssociatedWithRecipe(id)
    return {
      data: {
        recipeId: id,
        recipeName: recipe.name,
        ...associated,
      },
    }
  }

  async getCostSheets(id: string) {
    if (!this.costSheets) return { data: [] }
    await this.ensureRecipeExists(id)
    const data = await this.costSheets.getByRecipeId(id)
    return { data }
  }

  async getLaborCost(id: string) {
    if (!this.laborCosts) return { data: null }
    await this.ensureRecipeExists(id)
    const data = await this.laborCosts.getByRecipeId(id)
    return { data }
  }

  async upsertLaborCost(id: string, input: Record<string, unknown>) {
    if (!this.laborCosts) throw AppError.internal('Repositorio de mano de obra no disponible')
    await this.ensureRecipeExists(id)
    const concepts = (input.concepts as Array<Record<string, unknown>>) ?? []
    const entity = buildLaborCostEntity(
      id,
      concepts.map((c) => ({
        name: String(c.name),
        type: c.type as 'fixed' | 'per_unit' | 'per_batch',
        timeRequired: Number(c.timeRequired),
        timeUnit: c.timeUnit as 'minutes' | 'hours' | 'seconds',
        valuePerHour: Number(c.valuePerHour),
        operatorName: c.operatorName ? String(c.operatorName) : undefined,
        active: c.active !== false,
      })),
    )
    const data = await this.laborCosts.upsert(id, entity)
    return { data }
  }

  async getPackagingCost(id: string) {
    if (!this.packagingCosts) return { data: null }
    await this.ensureRecipeExists(id)
    const data = await this.packagingCosts.getByRecipeId(id)
    return { data }
  }

  async upsertPackagingCost(id: string, input: Record<string, unknown>) {
    if (!this.packagingCosts) throw AppError.internal('Repositorio de empaque no disponible')
    await this.ensureRecipeExists(id)
    const items = (input.items as Array<Record<string, unknown>>) ?? []
    const entity = buildPackagingCostEntity(
      id,
      items.map((i) => ({
        name: String(i.name),
        type: i.type as 'optional' | 'mandatory' | 'by_variant',
        unit: String(i.unit),
        quantity: Number(i.quantity),
        unitCost: Number(i.unitCost),
      })),
    )
    const data = await this.packagingCosts.upsert(id, entity)
    return { data }
  }

  async getProductionCost(id: string) {
    if (!this.productionCosts) return { data: null }
    await this.ensureRecipeExists(id)
    const data = await this.productionCosts.getByRecipeId(id)
    return { data }
  }

  async upsertProductionCost(id: string, input: Record<string, unknown>) {
    if (!this.productionCosts) throw AppError.internal('Repositorio de costos de producción no disponible')
    await this.ensureRecipeExists(id)
    const items = (input.items as Array<Record<string, unknown>>) ?? []
    const entity = buildRecipeProductionCostEntity(
      id,
      items.map((i) => ({
        name: String(i.name),
        type: i.type as 'fixed' | 'per_minute' | 'per_hour' | 'per_batch' | 'per_unit',
        value: Number(i.value),
        active: i.active !== false,
      })),
    )
    const data = await this.productionCosts.upsert(id, entity)
    return { data }
  }

  async getServiceCost(id: string) {
    if (!this.serviceCosts) return { data: null }
    await this.ensureRecipeExists(id)
    const data = await this.serviceCosts.getByRecipeId(id)
    return { data }
  }

  async upsertServiceCost(id: string, input: Record<string, unknown>) {
    if (!this.serviceCosts) throw AppError.internal('Repositorio de servicios no disponible')
    await this.ensureRecipeExists(id)
    const items = (input.items as Array<Record<string, unknown>>) ?? []
    const entity = buildServiceCostEntity(
      id,
      items.map((i) => ({
        name: String(i.name),
        type: i.type as 'fixed' | 'per_unit' | 'per_batch',
        value: Number(i.value),
        notes: i.notes ? String(i.notes) : undefined,
      })),
    )
    const data = await this.serviceCosts.upsert(id, entity)
    return { data }
  }

  private async ensureRecipeExists(id: string) {
    const recipe = await this.recipes.getById(id)
    if (!recipe) throw AppError.notFound('Receta no encontrada')
    return recipe
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

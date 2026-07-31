import { ObjectId } from 'mongodb'
import { AppError } from '../../../common/errors/app.error.js'
import { calculateProfit, calculatePrice } from '../../production/domain/value-objects/cost-breakdown.vo.js'
import type { ProductRepository } from '../../catalog/infrastructure/product.repository.js'
import type { RecipeRepository } from '../../production/infrastructure/recipe.repository.js'
import type { ProductionConfigRepository } from '../../production/infrastructure/production-config.repository.js'
import type { CostingService } from '../../production/services/costing.service.js'

function resolveRecipeId(
  product: { productionRecipeId?: string },
  variant: { production_recipe_id?: unknown },
): string | null {
  const variantRecipe = variant.production_recipe_id
  if (variantRecipe) {
    if (typeof variantRecipe === 'string') return variantRecipe
    if (typeof variantRecipe === 'object' && variantRecipe !== null && 'toString' in variantRecipe) {
      return (variantRecipe as { toString(): string }).toString()
    }
  }
  return product.productionRecipeId ?? null
}

export class AdminCostSummaryService {
  constructor(
    private readonly products: ProductRepository,
    private readonly recipes: RecipeRepository,
    private readonly config: ProductionConfigRepository,
    private readonly costing: CostingService,
  ) {}

  private async requireProduct(id: string) {
    if (!ObjectId.isValid(id)) throw AppError.badRequest('ID de producto no válido')
    const product = await this.products.getProductRawByIdOrSlug(id)
    if (!product) throw AppError.notFound('Producto no encontrado')
    return product
  }

  async getRecipe(productId: string) {
    const product = await this.requireProduct(productId)
    return {
      data: {
        recipeId: product.productionRecipeId ?? null,
        production: product.production ?? null,
      },
    }
  }

  async assignRecipe(productId: string, recipeId: string) {
    await this.requireProduct(productId)
    const recipe = await this.recipes.getById(recipeId)
    if (!recipe) throw AppError.notFound('Receta no encontrada')
    const ok = await this.products.assignProductionRecipe(productId, recipeId)
    if (!ok) throw AppError.notFound('Producto no encontrado')
    return { data: { recipeId } }
  }

  async unassignRecipe(productId: string) {
    await this.requireProduct(productId)
    await this.products.unassignProductionRecipe(productId)
    return { data: { success: true } }
  }

  async recalculateProductRecipe(productId: string, userId: string) {
    const product = await this.requireProduct(productId)
    if (!product.productionRecipeId) throw AppError.notFound('El producto no tiene receta asignada')
    const result = await this.costing.calculateRecipeCost(product.productionRecipeId, userId)
    const breakdown = result.data
    await this.products.updateProductProduction(productId, {
      totalCost: breakdown.totalCost,
      suggestedPrice: breakdown.suggestedPrice ?? 0,
      materialCost: breakdown.materialsCost,
      margin: breakdown.marginPercentage,
      updatedAt: new Date().toISOString(),
    })
    return { data: { productId, costsUpdated: true, costs: result.data } }
  }

  async patchVariantRecipe(productId: string, sku: string, recipeId: string | null) {
    const product = await this.requireProduct(productId)
    const decodedSku = decodeURIComponent(sku)
    const variant = await this.products.getVariantRaw(product.slug, decodedSku)
    if (!variant) throw AppError.notFound('Variante no encontrada')
    if (recipeId) {
      if (!ObjectId.isValid(recipeId)) throw AppError.badRequest('ID de receta no válido')
      const recipe = await this.recipes.getById(recipeId)
      if (!recipe) throw AppError.notFound('Receta no encontrada')
    }
    await this.products.updateVariantRecipe(product.slug, decodedSku, recipeId)
    return { data: { success: true } }
  }

  async getCostSummary(productId: string) {
    const product = await this.requireProduct(productId)
    const recipe = await this.recipes.getByProductSlug(product.slug)

    if (!recipe) {
      return {
        data: {
          productSlug: product.slug,
          hasRecipe: false,
          materialsCost: 0,
          indirectCost: 0,
          totalCost: 0,
          costsOutdated: false,
        },
      }
    }

    let profitSummary = null
    if (recipe.cachedTotalCost > 0 && recipe.suggestedPrice) {
      profitSummary = calculateProfit(recipe.suggestedPrice, recipe.cachedTotalCost)
    }

    return {
      data: {
        productSlug: product.slug,
        hasRecipe: true,
        recipeId: recipe.id,
        recipeVersion: recipe.version,
        materialsCost: recipe.cachedMaterialsCost,
        indirectCost: recipe.cachedIndirectCost,
        totalCost: recipe.cachedTotalCost,
        marginPercentage: recipe.marginPercentage,
        suggestedPrice: recipe.suggestedPrice,
        actualPrice: recipe.actualPrice,
        pricingMode: recipe.pricingMode,
        manualPrice: recipe.manualPrice,
        costsOutdated: recipe.costsOutdated,
        lastCalculatedAt: recipe.costsLastCalculatedAt,
        profitPerUnit: profitSummary?.profitPerUnit,
        profitMarginPercent: profitSummary?.profitMarginPercent,
      },
    }
  }

  async postCostSummary(productId: string, userId: string) {
    return this.recalculateProductRecipe(productId, userId)
  }

  async getCostStatus(productId: string) {
    const product = await this.requireProduct(productId)
    const hasRecipe = !!product.productionRecipeId
    const variants = await this.products.listVariantsByProductSlug(product.slug)
    const latestSnapshots = await this.products.getLatestSnapshotsByProduct(String(product._id))
    const snapshotMap = new Map(
      latestSnapshots.map((s) => [
        String((s as { _id: string })._id),
        s as { suggested_price?: number; margin_percentage?: number; calculated_at?: Date },
      ]),
    )

    const items = variants.map((v) => {
      const snap = snapshotMap.get(v.sku)
      const lastCalc = snap?.calculated_at ?? null
      let status: 'updated' | 'pending_recalculate' | 'outdated'
      if (!hasRecipe) status = 'outdated'
      else if (!lastCalc) status = 'pending_recalculate'
      else status = 'updated'

      return {
        sku: v.sku,
        status,
        lastCalculatedAt: lastCalc instanceof Date ? lastCalc.toISOString() : null,
        lastSuggestedPrice: snap?.suggested_price ?? null,
        currentPrice: v.price ?? 0,
        marginPercentage: snap?.margin_percentage ?? null,
      }
    })

    return {
      data: {
        items,
        summary: {
          hasRecipe,
          total: items.length,
          updated: items.filter((i) => i.status === 'updated').length,
          pendingRecalculate: items.filter((i) => i.status === 'pending_recalculate').length,
          outdated: items.filter((i) => i.status === 'outdated').length,
        },
      },
    }
  }

  async calculateVariantCost(productId: string, sku: string, body: Record<string, unknown>, userId: string) {
    const product = await this.requireProduct(productId)
    const decodedSku = decodeURIComponent(sku)
    const variant = await this.products.getVariantRaw(product.slug, decodedSku)
    if (!variant) throw AppError.notFound('Variante no encontrada')

    const recipeId = resolveRecipeId(product, variant)
    if (!recipeId) throw AppError.badRequest('Ni la variante ni el producto tienen receta asignada')

    const marginOverride = body.margin != null ? Number(body.margin) : undefined
    const productionConfig = await this.config.get()
    const margin = marginOverride ?? productionConfig.suggestedProfitPercentage

    const costResult = await this.costing.calculateRecipeCost(recipeId, userId)
    const breakdown = costResult.data
    const pricing = calculatePrice(
      breakdown.totalCost,
      breakdown.totalCost,
      margin,
      {
        currency: productionConfig.currency,
        priceRounding: productionConfig.priceRounding,
        psychologicalRounding: productionConfig.psychologicalRounding,
        taxPercentage: productionConfig.taxPercentage,
        minimumProfitPercentage: productionConfig.minimumProfitPercentage,
        suggestedProfitPercentage: productionConfig.suggestedProfitPercentage,
        premiumProfitPercentage: productionConfig.premiumProfitPercentage,
        wholesaleProfitPercentage: productionConfig.wholesaleProfitPercentage,
        distributorProfitPercentage: productionConfig.distributorProfitPercentage,
      },
    )

    return {
      data: {
        productId,
        productName: product.name,
        variantSku: decodedSku,
        currentPrice: variant.price,
        currency: productionConfig.currency,
        marginUsed: margin,
        cost: {
          materialsCost: breakdown.materialsCost,
          indirectCostTotal: breakdown.indirectCostTotal,
          totalCost: breakdown.totalCost,
          lines: breakdown.lines,
          indirectCosts: breakdown.indirectCosts,
          suggestedPrice: pricing.suggestedPrice,
          marginPercentage: margin,
        },
      },
    }
  }

  async calculateAndSave(
    productId: string,
    sku: string,
    body: Record<string, unknown>,
    userId: string,
  ) {
    const calc = await this.calculateVariantCost(productId, sku, body, userId)
    const product = await this.requireProduct(productId)
    const decodedSku = decodeURIComponent(sku)
    const variant = await this.products.getVariantRaw(product.slug, decodedSku)
    if (!variant) throw AppError.notFound('Variante no encontrada')
    const recipeId = resolveRecipeId(product, variant)
    if (!recipeId) throw AppError.badRequest('Receta no asignada')
    const recipe = await this.recipes.getById(recipeId)
    if (!recipe) throw AppError.notFound('Receta no encontrada')
    const autoApprove = body.autoApprove === true

    const snapshotId = await this.products.insertCostSnapshot({
      product_id: new ObjectId(productId),
      variant_sku: decodedSku,
      recipe_id: recipeId,
      recipe_version: recipe.version,
      margin_percentage: calc.data.marginUsed,
      suggested_price: calc.data.cost.suggestedPrice,
      total_cost: calc.data.cost.totalCost,
      cost_per_unit: calc.data.cost.totalCost,
      price_applied: autoApprove ? calc.data.cost.suggestedPrice : null,
      profit_amount: calc.data.cost.suggestedPrice - calc.data.cost.totalCost,
      profit_percent:
        calc.data.cost.totalCost > 0
          ? Math.round(((calc.data.cost.suggestedPrice - calc.data.cost.totalCost) / calc.data.cost.totalCost) * 10000) / 100
          : 0,
      currency: calc.data.currency,
      breakdown: {
        materials: { label: 'Materiales', amount: calc.data.cost.materialsCost, details: [] },
        packaging: { label: 'Empaque', amount: 0, details: [] },
        labor: { label: 'Mano de obra', amount: 0, details: [] },
        services: { label: 'Servicios', amount: 0, details: [] },
        indirect_costs: { label: 'Indirectos', amount: calc.data.cost.indirectCostTotal, details: [] },
        waste: { label: 'Merma', amount: 0, details: [] },
      },
      calculated_by: userId,
    })

    await this.products.updateVariantProductionData(product.slug, decodedSku, {
      totalCost: calc.data.cost.totalCost,
      suggestedPrice: calc.data.cost.suggestedPrice,
      materialCost: calc.data.cost.materialsCost,
      margin: calc.data.marginUsed,
      updatedAt: new Date().toISOString(),
    })

    if (autoApprove) {
      await this.products.updateVariantPrice(decodedSku, calc.data.cost.suggestedPrice)
    }

    return {
      data: {
        ...calc.data,
        costSheetId: snapshotId,
        approvalStatus: autoApprove ? 'published' : 'pending',
      },
    }
  }

  async saveSnapshot(productId: string, sku: string, body: Record<string, unknown>, userId: string) {
    const product = await this.requireProduct(productId)
    const decodedSku = decodeURIComponent(sku)
    const variant = await this.products.getVariantRaw(product.slug, decodedSku)
    if (!variant) throw AppError.notFound('Variante no encontrada')

    const marginPercentage = Number(body.marginPercentage)
    const suggestedPrice = Number(body.suggestedPrice)
    const totalCost = Number(body.totalCost)
    const costPerUnit = Number(body.costPerUnit)
    const recipeId = String(body.recipeId ?? '')
    const recipeVersion = Number(body.recipeVersion)
    if (
      !Number.isFinite(marginPercentage) ||
      !Number.isFinite(suggestedPrice) ||
      !Number.isFinite(totalCost) ||
      !Number.isFinite(costPerUnit) ||
      !recipeId ||
      !Number.isFinite(recipeVersion)
    ) {
      throw AppError.badRequest('Datos de snapshot inválidos')
    }

    const breakdown = (body.breakdown ?? {}) as Record<string, { label?: string; amount?: number; details?: unknown[] }>
    const profitAmount = suggestedPrice - totalCost
    const profitPercent = totalCost > 0 ? Math.round((profitAmount / totalCost) * 10000) / 100 : 0

    const id = await this.products.insertCostSnapshot({
      product_id: new ObjectId(productId),
      variant_sku: decodedSku,
      recipe_id: recipeId,
      recipe_version: recipeVersion,
      margin_percentage: marginPercentage,
      suggested_price: suggestedPrice,
      total_cost: totalCost,
      cost_per_unit: costPerUnit,
      price_applied: body.priceApplied != null ? Number(body.priceApplied) : null,
      profit_amount: Math.round(profitAmount * 100) / 100,
      profit_percent: profitPercent,
      currency: typeof body.currency === 'string' ? body.currency : 'COP',
      breakdown: {
        materials: breakdown.materials ?? { label: 'Materiales directos', amount: 0, details: [] },
        packaging: breakdown.packaging ?? { label: 'Empaque', amount: 0, details: [] },
        labor: breakdown.labor ?? { label: 'Mano de obra', amount: 0, details: [] },
        services: breakdown.services ?? { label: 'Servicios externos', amount: 0, details: [] },
        indirect_costs: breakdown.indirectCosts ?? { label: 'Costos indirectos', amount: 0, details: [] },
        waste: breakdown.waste ?? { label: 'Desperdicio / Merma', amount: 0, details: [] },
      },
      calculated_by: userId,
    })

    return {
      data: {
        id,
        productId,
        variantSku: decodedSku,
        marginPercentage,
        suggestedPrice,
        totalCost,
        costPerUnit,
        profitAmount: Math.round(profitAmount * 100) / 100,
        profitPercent,
        currency: typeof body.currency === 'string' ? body.currency : 'COP',
        calculatedAt: new Date().toISOString(),
      },
    }
  }

  async listSnapshots(productId: string, sku: string) {
    if (!ObjectId.isValid(productId)) throw AppError.badRequest('ID de producto no válido')
    const decodedSku = decodeURIComponent(sku)
    const snapshots = await this.products.listCostSnapshots(productId, decodedSku)

    const items = snapshots.map((s) => {
      const row = s as Record<string, unknown>
      return {
        id: String(row._id),
        productId,
        variantSku: String(row.variant_sku),
        recipeId: row.recipe_id,
        recipeVersion: row.recipe_version,
        marginPercentage: row.margin_percentage,
        suggestedPrice: row.suggested_price,
        totalCost: row.total_cost,
        costPerUnit: row.cost_per_unit,
        priceApplied: row.price_applied ?? null,
        profitAmount: row.profit_amount ?? null,
        profitPercent: row.profit_percent ?? null,
        currency: row.currency ?? 'COP',
        breakdown: {
          materials: (row.breakdown as Record<string, unknown>)?.materials ?? { label: 'Materiales directos', amount: 0, details: [] },
          packaging: (row.breakdown as Record<string, unknown>)?.packaging ?? { label: 'Empaque', amount: 0, details: [] },
          labor: (row.breakdown as Record<string, unknown>)?.labor ?? { label: 'Mano de obra', amount: 0, details: [] },
          services: (row.breakdown as Record<string, unknown>)?.services ?? { label: 'Servicios externos', amount: 0, details: [] },
          indirectCosts: (row.breakdown as Record<string, unknown>)?.indirect_costs ?? { label: 'Costos indirectos', amount: 0, details: [] },
          waste: (row.breakdown as Record<string, unknown>)?.waste ?? { label: 'Desperdicio / Merma', amount: 0, details: [] },
        },
        calculatedBy: row.calculated_by != null ? String(row.calculated_by) : '',
        calculatedAt:
          row.calculated_at instanceof Date
            ? row.calculated_at.toISOString()
            : row.calculated_at
              ? String(row.calculated_at)
              : '',
      }
    })

    return { data: items }
  }
}

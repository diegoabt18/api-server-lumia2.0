import { ObjectId } from 'mongodb'
import { AppError } from '../../../common/errors/app.error.js'
import type { ProductRepository } from '../../catalog/infrastructure/product.repository.js'
import {
  resolveVariantRepostStatus,
  type VariantRepostContext,
} from '../domain/repost-status.js'
import type { CostSheetRepository } from '../infrastructure/cost-sheet.repository.js'
import type { PriceApprovalRepository } from '../infrastructure/price-approval.repository.js'
import type { ProductionAuditRepository } from '../infrastructure/production-audit.repository.js'
import type { RecipeRepository } from '../infrastructure/recipe.repository.js'
import type { CostingService } from './costing.service.js'
import { calculateShelfPrice } from '../domain/value-objects/cost-breakdown.vo.js'

export interface RepostVariantPriceResult {
  variantSku: string
  productId: string
  productName: string
  /** Precio final con IVA que se publicaría (o el actual si se omitió). */
  suggestedPrice: number
  currentPrice: number
  approvalId: string
  costSheetId: string
  skipped?: boolean
  skipReason?: string
}

export class VariantPriceRepostService {
  constructor(
    private readonly products: ProductRepository,
    private readonly recipes: RecipeRepository,
    private readonly costing: CostingService,
    private readonly costSheets: CostSheetRepository,
    private readonly approvals: PriceApprovalRepository,
    private readonly audit: ProductionAuditRepository,
  ) {}

  async repostProductPrices(productId: string, userId: string) {
    if (!ObjectId.isValid(productId)) throw AppError.badRequest('ID de producto no válido')

    const product = await this.products.findBySlugOrId(productId)
    if (!product) throw AppError.notFound('Producto no encontrado')
    const productRecipeId = await this.resolveProductRecipeId(product.id)

    const variantDocs = await this.products.listVariantsByProductSlug(product.slug)
    const results: RepostVariantPriceResult[] = []
    const errors: string[] = []
    let reposted = 0
    let skipped = 0

    for (const v of variantDocs) {
      const sku = v.sku
      if (!sku) continue
      try {
        const result = await this.repostVariantPrice({
          productId: product.id,
          productName: product.name,
          productSlug: product.slug,
          productTaxRate: product.taxRate ?? null,
          productRecipeId,
          variantSku: sku,
          variantRecipeId: v.production_recipe_id != null ? String(v.production_recipe_id) : null,
          currentPrice: v.price ?? 0,
          costStatus: (v as { cost_status?: string }).cost_status ?? null,
          userId,
        })
        results.push(result)
        if (result.skipped) skipped++
        else reposted++
      } catch (e) {
        errors.push(`${sku}: ${e instanceof Error ? e.message : 'Error desconocido'}`)
      }
    }

    return {
      data: {
        results,
        reposted,
        skipped,
        errors,
        message:
          reposted > 0
            ? `${reposted} variante(s) enviada(s) a aprobación`
            : skipped > 0
              ? 'No había variantes pendientes de reposteo'
              : 'Sin variantes procesadas',
      },
    }
  }

  async repostAllNeedingRepost(userId: string) {
    const { data: products } = await this.products.listForProduction({
      limit: 500,
      skip: 0,
      fetchAllForFilter: true,
    })

    const allRecipeIds = new Set<string>()
    for (const p of products) {
      if (p.productionRecipeId) allRecipeIds.add(p.productionRecipeId)
      for (const rid of p.variantRecipeIds ?? []) allRecipeIds.add(rid)
    }
    const recipes = await this.recipes.getByIds([...allRecipeIds])
    const recipeMap = new Map(recipes.map((r) => [r.id, r]))
    const allSkus = products.flatMap((p) => (p.variants ?? []).map((v) => v.sku))
    const [sheetBySku, pendingBySku] = await Promise.all([
      this.costSheets.getLatestRecipeVersionsBySkus(allSkus),
      this.approvals.listPendingVariantSkus(),
    ])

    const productIdsToRepost: string[] = []
    for (const p of products) {
      const contexts: VariantRepostContext[] = (p.variants ?? []).map((v) => {
        const recipeId = v.productionRecipeId ?? p.productionRecipeId
        const recipe = recipeId ? recipeMap.get(recipeId) : undefined
        return {
          sku: v.sku,
          hasRecipe: !!recipeId,
          recipeId,
          recipeVersion: recipe?.version ?? null,
          recipeCostsOutdated: recipe?.costsOutdated ?? false,
          lastPublishedRecipeVersion: sheetBySku.get(v.sku) ?? null,
          costStatus: v.costStatus ?? null,
          hasPendingApproval: pendingBySku.has(v.sku),
        }
      })
      const needs = contexts.some((c) => resolveVariantRepostStatus(c) === 'needs_repost')
      if (needs) productIdsToRepost.push(p.id)
    }

    let totalReposted = 0
    let totalSkipped = 0
    const errors: string[] = []
    const byProduct: { productId: string; reposted: number; skipped: number }[] = []

    for (const productId of productIdsToRepost) {
      const result = await this.repostProductPrices(productId, userId)
      totalReposted += result.data.reposted
      totalSkipped += result.data.skipped
      errors.push(...result.data.errors)
      byProduct.push({
        productId,
        reposted: result.data.reposted,
        skipped: result.data.skipped,
      })
    }

    return {
      data: {
        productsProcessed: productIdsToRepost.length,
        reposted: totalReposted,
        skipped: totalSkipped,
        errors,
        byProduct,
        message:
          totalReposted > 0
            ? `${totalReposted} variante(s) enviada(s) a aprobación en ${productIdsToRepost.length} producto(s)`
            : 'No había productos pendientes de reposteo',
      },
    }
  }

  private async resolveProductRecipeId(productId: string): Promise<string | null> {
    const raw = await this.products.getProductRawByIdOrSlug(productId)
    const id = (raw as { productionRecipeId?: unknown } | null)?.productionRecipeId
    return id != null ? String(id) : null
  }

  private async repostVariantPrice(input: {
    productId: string
    productName: string
    productSlug: string
    /** IVA del producto (%). null = sin configurar: no se envía a aprobación. */
    productTaxRate: number | null
    productRecipeId: string | null
    variantSku: string
    variantRecipeId: string | null
    currentPrice: number
    costStatus: string | null
    userId: string
  }): Promise<RepostVariantPriceResult> {
    const recipeId = input.variantRecipeId ?? input.productRecipeId
    if (!recipeId) {
      throw new Error(`La variante ${input.variantSku} no tiene receta asignada`)
    }

    const pending = await this.approvals.getByVariantSku(input.variantSku)
    if (pending.some((a) => a.status === 'pending')) {
      return {
        variantSku: input.variantSku,
        productId: input.productId,
        productName: input.productName,
        suggestedPrice: input.currentPrice,
        currentPrice: input.currentPrice,
        approvalId: '',
        costSheetId: '',
        skipped: true,
        skipReason: 'Ya existe una solicitud de aprobación pendiente',
      }
    }

    const recipe = await this.recipes.getById(recipeId)
    if (!recipe) throw new Error('Receta no encontrada')

    const previousCostSheet = await this.costSheets.getLatestByVariantSku(input.variantSku)
    const repostCtx: VariantRepostContext = {
      sku: input.variantSku,
      hasRecipe: true,
      recipeId,
      recipeVersion: recipe.version,
      recipeCostsOutdated: recipe.costsOutdated,
      lastPublishedRecipeVersion: previousCostSheet?.recipeVersion ?? null,
      costStatus: input.costStatus,
      hasPendingApproval: false,
    }
    if (resolveVariantRepostStatus(repostCtx) === 'up_to_date') {
      return {
        variantSku: input.variantSku,
        productId: input.productId,
        productName: input.productName,
        suggestedPrice: previousCostSheet?.suggestedPrice ?? input.currentPrice,
        currentPrice: input.currentPrice,
        approvalId: '',
        costSheetId: previousCostSheet?.id ?? '',
        skipped: true,
        skipReason: 'Precio ya sincronizado con la receta actual',
      }
    }

    // Los precios de catálogo incluyen IVA: sin la tasa del producto no se puede calcular el precio final.
    if (input.productTaxRate == null) {
      throw new Error('Configura el IVA del producto (0 si está excluido) antes de enviarlo a aprobación')
    }

    const costResult = await this.costing.calculateRecipeCost(recipeId, input.userId)
    const breakdown = costResult.data
    if (breakdown.suggestedPrice == null || breakdown.suggestedPrice <= 0) {
      throw new Error('No se pudo calcular un precio sugerido (revisa margen de la receta)')
    }
    const shelf = calculateShelfPrice({
      totalCost: breakdown.totalCost,
      marginPercentage: breakdown.marginPercentage,
      taxRate: input.productTaxRate,
      rounding: breakdown.config.priceRounding,
    })
    const suggestedPrice = shelf.grossPrice

    const previousCost = previousCostSheet?.totalCost ?? breakdown.totalCost
    const costSheet = await this.costSheets.createForVariant({
      recipeId,
      recipeVersion: recipe.version,
      variantSku: input.variantSku,
      productSlug: input.productSlug,
      materialsCost: breakdown.materialsCost,
      indirectCost: breakdown.indirectCostTotal,
      totalCost: breakdown.totalCost,
      suggestedPrice,
      suggestedPriceNet: shelf.netFromGross,
      taxRate: shelf.taxRate,
      marginPercentage: breakdown.marginPercentage,
      currency: breakdown.config.currency,
      calculatedBy: input.userId,
    })

    const approval = await this.approvals.create({
      variantSku: input.variantSku,
      productSlug: input.productSlug,
      productName: input.productName,
      previousCost,
      newCost: breakdown.totalCost,
      materialsCost: breakdown.materialsCost,
      previousPrice: input.currentPrice,
      suggestedPrice,
      suggestedPriceNet: shelf.netFromGross,
      taxRate: shelf.taxRate,
      marginPercentage: breakdown.marginPercentage,
      currency: breakdown.config.currency,
      costSheetId: costSheet.id,
      recipeId,
      recipeVersion: recipe.version,
      createdBy: input.userId,
    })

    await this.products.updateVariantPricingState(input.productSlug, input.variantSku, {
      suggestedPrice,
      pricingStatus: 'pending_approval',
      costStatus: 'up_to_date',
      productionData: {
        totalCost: breakdown.totalCost,
        suggestedPrice,
        suggestedPriceNet: shelf.netFromGross,
        taxRate: shelf.taxRate,
        materialCost: breakdown.materialsCost,
        margin: breakdown.marginPercentage,
        updatedAt: new Date().toISOString(),
      },
    })

    await this.audit.insert({
      event_type: 'variant_cost_calculated',
      entity_type: 'variant',
      entity_id: input.variantSku,
      description: `Reposteo de precio desde receta v${recipe.version} para ${input.variantSku}. Precio sugerido: ${suggestedPrice} (IVA ${shelf.taxRate} % incluido)`,
      metadata: {
        recipeId,
        recipeVersion: recipe.version,
        totalCost: breakdown.totalCost,
        suggestedPrice,
        suggestedPriceNet: shelf.netFromGross,
        taxRate: shelf.taxRate,
        costSheetId: costSheet.id,
        approvalId: approval.id,
        source: 'recipe_repost',
      },
      performed_by: ObjectId.isValid(input.userId) ? new ObjectId(input.userId) : input.userId,
      created_at: new Date(),
    })

    return {
      variantSku: input.variantSku,
      productId: input.productId,
      productName: input.productName,
      suggestedPrice,
      currentPrice: input.currentPrice,
      approvalId: approval.id,
      costSheetId: costSheet.id,
    }
  }
}

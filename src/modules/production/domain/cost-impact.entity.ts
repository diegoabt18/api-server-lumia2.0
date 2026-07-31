export type ImpactStatus = 'detected' | 'recalculated' | 'resolved'
export type ImpactChangeType = 'material_price' | 'recipe_change' | 'labor_change' | 'config_change'

export interface AffectedVariantEntry {
  sku: string
  product_slug: string
  recipe_id: unknown
}

export interface CostImpactEntity {
  _id?: unknown
  change_type: ImpactChangeType
  change_description: string
  material_id?: unknown
  material_name: string
  previous_price?: number
  new_price?: number
  affected_recipes_count: number
  affected_variants_count: number
  affected_products_count: number
  status: ImpactStatus
  affected_recipes: unknown[]
  affected_variants: AffectedVariantEntry[]
  recalculated_at?: Date
  resolved_at?: Date
  detected_by?: unknown
  detected_at: Date
  created_at: Date
  updated_at: Date
}

export interface CostImpactDomain {
  id: string
  changeType: ImpactChangeType
  changeDescription: string
  materialId?: string
  materialName: string
  previousPrice?: number
  newPrice?: number
  affectedRecipesCount: number
  affectedVariantsCount: number
  affectedProductsCount: number
  status: ImpactStatus
  affectedRecipes: string[]
  affectedVariants: { sku: string; productSlug: string; recipeId: string }[]
  recalculatedAt?: string
  resolvedAt?: string
  detectedBy?: string
  detectedAt: string
  createdAt: string
  updatedAt: string
}

export function toCostImpactDomain(
  entity: CostImpactEntity & { _id?: { toString(): string } },
): CostImpactDomain {
  return {
    id: entity._id?.toString?.() ?? '',
    changeType: entity.change_type,
    changeDescription: entity.change_description,
    materialId: (entity.material_id as { toString?: () => string })?.toString?.(),
    materialName: entity.material_name,
    previousPrice: entity.previous_price,
    newPrice: entity.new_price,
    affectedRecipesCount: entity.affected_recipes_count,
    affectedVariantsCount: entity.affected_variants_count,
    affectedProductsCount: entity.affected_products_count,
    status: entity.status,
    affectedRecipes: (entity.affected_recipes ?? []).map(
      (r) => (r as { toString?: () => string })?.toString?.() ?? String(r),
    ),
    affectedVariants: (entity.affected_variants ?? []).map((v) => ({
      sku: v.sku,
      productSlug: v.product_slug,
      recipeId: (v.recipe_id as { toString?: () => string })?.toString?.() ?? '',
    })),
    recalculatedAt: entity.recalculated_at?.toISOString?.(),
    resolvedAt: entity.resolved_at?.toISOString?.(),
    detectedBy: (entity.detected_by as { toString?: () => string })?.toString?.(),
    detectedAt: entity.detected_at?.toISOString?.() ?? '',
    createdAt: entity.created_at?.toISOString?.() ?? '',
    updatedAt: entity.updated_at?.toISOString?.() ?? '',
  }
}

export function resolveCostImpactPatch(): Partial<CostImpactEntity> {
  return { status: 'resolved', resolved_at: new Date(), updated_at: new Date() }
}

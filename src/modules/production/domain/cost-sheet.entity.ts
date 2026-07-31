export interface CostSheetEntity {
  _id?: unknown
  recipe_id: unknown
  variant_sku?: string
  materials_cost: number
  indirect_cost: number
  total_cost: number
  suggested_price?: number
  margin_percentage?: number
  currency: string
  calculated_at: Date
  calculated_by?: unknown
}

export interface CostSheetDomain {
  id: string
  recipeId: string
  variantSku?: string
  materialsCost: number
  indirectCost: number
  totalCost: number
  suggestedPrice?: number
  marginPercentage?: number
  currency: string
  calculatedAt: string
  calculatedBy?: string
}

export function toCostSheetDomain(
  entity: CostSheetEntity & { _id?: { toString(): string } },
): CostSheetDomain {
  return {
    id: entity._id?.toString?.() ?? '',
    recipeId: (entity.recipe_id as { toString?: () => string })?.toString?.() ?? '',
    variantSku: entity.variant_sku,
    materialsCost: entity.materials_cost,
    indirectCost: entity.indirect_cost,
    totalCost: entity.total_cost,
    suggestedPrice: entity.suggested_price,
    marginPercentage: entity.margin_percentage,
    currency: entity.currency,
    calculatedAt: entity.calculated_at?.toISOString?.() ?? '',
    calculatedBy: (entity.calculated_by as { toString?: () => string })?.toString?.(),
  }
}

export interface CostSheetEntity {
  _id?: unknown
  recipe_id: unknown
  recipe_version?: number
  variant_sku?: string
  product_slug?: string
  materials_cost: number
  indirect_cost: number
  /** Compat LUMIA cost_sheets_v2 */
  total_cost_with_waste?: number
  total_cost: number
  /** Precio final con IVA (hojas creadas al enviar a aprobación desde la regla con IVA). */
  suggested_price?: number
  suggested_price_net?: number
  tax_rate?: number
  margin_percentage?: number
  currency: string
  calculated_at: Date
  calculated_by?: unknown
}

export interface CostSheetDomain {
  id: string
  recipeId: string
  recipeVersion?: number
  variantSku?: string
  productSlug?: string
  materialsCost: number
  indirectCost: number
  totalCost: number
  suggestedPrice?: number
  suggestedPriceNet?: number
  taxRate?: number
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
    recipeVersion: entity.recipe_version,
    variantSku: entity.variant_sku,
    productSlug: entity.product_slug,
    materialsCost: entity.materials_cost,
    indirectCost: entity.indirect_cost,
    totalCost: entity.total_cost_with_waste ?? entity.total_cost,
    suggestedPrice: entity.suggested_price,
    suggestedPriceNet: entity.suggested_price_net,
    taxRate: entity.tax_rate,
    marginPercentage: entity.margin_percentage,
    currency: entity.currency,
    calculatedAt: entity.calculated_at?.toISOString?.() ?? '',
    calculatedBy: (entity.calculated_by as { toString?: () => string })?.toString?.(),
  }
}

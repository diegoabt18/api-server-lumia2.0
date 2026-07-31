import type { UnitOfMeasure } from './value-objects/unit-of-measure.vo.js'

export interface RecipeLineEntity {
  material_id: unknown
  material_name: string
  material_code?: string
  material_purchase_unit?: string
  rollo_meters?: number
  unit: UnitOfMeasure
  quantity: number
  unit_cost: number
  partial_cost: number
}

export interface IndirectCostEntity {
  name: string
  type: 'fixed' | 'percentage'
  value: number
  optional: boolean
}

export interface RecipeEntity {
  _id?: unknown
  name: string
  product_slug: string
  product_name?: string
  variant_sku?: string
  version: number
  is_active: boolean
  lines: RecipeLineEntity[]
  indirect_costs: IndirectCostEntity[]
  cached_materials_cost: number
  cached_indirect_cost: number
  cached_total_cost: number
  currency: string
  margin_percentage?: number
  pricing_mode: 'auto_margin' | 'fixed_margin' | 'manual'
  manual_price?: number
  suggested_price?: number
  actual_price?: number
  costs_outdated: boolean
  costs_last_calculated_at?: Date
  costs_last_calculated_by?: unknown
  created_at: Date
  updated_at: Date
}

export interface RecipeLineDomain {
  materialId: string
  materialName: string
  materialCode?: string
  materialPurchaseUnit?: string
  rolloMeters?: number
  unit: UnitOfMeasure
  quantity: number
  unitCost: number
  partialCost: number
}

export interface IndirectCostDomain {
  name: string
  type: 'fixed' | 'percentage'
  value: number
  optional: boolean
}

export interface RecipeDomain {
  id: string
  name: string
  productSlug: string
  productName?: string
  variantSku?: string
  version: number
  isActive: boolean
  lines: RecipeLineDomain[]
  indirectCosts: IndirectCostDomain[]
  cachedMaterialsCost: number
  cachedIndirectCost: number
  cachedTotalCost: number
  currency: string
  marginPercentage?: number
  pricingMode: 'auto_margin' | 'fixed_margin' | 'manual'
  manualPrice?: number
  suggestedPrice?: number
  actualPrice?: number
  costsOutdated: boolean
  costsLastCalculatedAt?: string
  costsLastCalculatedBy?: string
  createdAt: string
  updatedAt: string
}

export function toRecipeDomain(entity: RecipeEntity & { _id?: { toString(): string } }): RecipeDomain {
  return {
    id: entity._id?.toString?.() ?? '',
    name: entity.name ?? '',
    productSlug: entity.product_slug,
    productName: entity.product_name,
    variantSku: entity.variant_sku,
    version: entity.version,
    isActive: entity.is_active,
    lines: (entity.lines ?? []).map((l) => ({
      materialId: (l.material_id as { toString?: () => string })?.toString?.() ?? '',
      materialName: l.material_name,
      materialCode: l.material_code,
      materialPurchaseUnit: l.material_purchase_unit,
      rolloMeters: l.rollo_meters,
      unit: l.unit,
      quantity: l.quantity,
      unitCost: l.unit_cost,
      partialCost: l.partial_cost,
    })),
    indirectCosts: (entity.indirect_costs ?? []).map((ic) => ({
      name: ic.name,
      type: ic.type,
      value: ic.value,
      optional: ic.optional,
    })),
    cachedMaterialsCost: entity.cached_materials_cost,
    cachedIndirectCost: entity.cached_indirect_cost,
    cachedTotalCost: entity.cached_total_cost,
    currency: entity.currency,
    marginPercentage: entity.margin_percentage,
    pricingMode: entity.pricing_mode,
    manualPrice: entity.manual_price,
    suggestedPrice: entity.suggested_price,
    actualPrice: entity.actual_price,
    costsOutdated: entity.costs_outdated,
    costsLastCalculatedAt: entity.costs_last_calculated_at?.toISOString?.(),
    costsLastCalculatedBy: (entity.costs_last_calculated_by as { toString?: () => string })?.toString?.(),
    createdAt: entity.created_at?.toISOString?.() ?? '',
    updatedAt: entity.updated_at?.toISOString?.() ?? '',
  }
}

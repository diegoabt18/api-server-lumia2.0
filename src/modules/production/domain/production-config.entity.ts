import type { IndirectCostEntity } from './recipe.entity.js'

export const PRODUCTION_CONFIG_ID = 'global_production_config'

export interface ProductionConfigEntity {
  _id: string
  default_margin_percentage: number
  currency: string
  decimal_places: number
  price_rounding: number
  default_indirect_costs: IndirectCostEntity[]
  tax_percentage?: number
  minimum_profit_percentage: number
  suggested_profit_percentage: number
  premium_profit_percentage: number
  wholesale_profit_percentage: number
  distributor_profit_percentage: number
  psychological_rounding: number
  default_labor_cost_per_hour: number
  default_energy_cost_per_hour: number
  global_waste_percent: number
  updated_by?: unknown
  updated_at: Date
}

export interface ProductionConfigDomain {
  defaultMarginPercentage: number
  currency: string
  decimalPlaces: number
  priceRounding: number
  defaultIndirectCosts: IndirectCostEntity[]
  taxPercentage?: number
  minimumProfitPercentage: number
  suggestedProfitPercentage: number
  premiumProfitPercentage: number
  wholesaleProfitPercentage: number
  distributorProfitPercentage: number
  psychologicalRounding: number
  defaultLaborCostPerHour: number
  defaultEnergyCostPerHour: number
  globalWastePercent: number
  updatedBy?: string
  updatedAt?: string
}

export const PRODUCTION_CONFIG_DEFAULTS: Omit<ProductionConfigEntity, '_id' | 'updated_by' | 'updated_at'> = {
  default_margin_percentage: 80,
  currency: 'COP',
  decimal_places: 0,
  price_rounding: 100,
  default_indirect_costs: [
    { name: 'Mano de obra', type: 'fixed', value: 0, optional: true },
    { name: 'Electricidad', type: 'percentage', value: 0, optional: true },
    { name: 'Empaque', type: 'fixed', value: 0, optional: true },
    { name: 'Desgaste de herramientas', type: 'percentage', value: 0, optional: true },
  ],
  minimum_profit_percentage: 30,
  suggested_profit_percentage: 80,
  premium_profit_percentage: 150,
  wholesale_profit_percentage: 20,
  distributor_profit_percentage: 15,
  psychological_rounding: 900,
  default_labor_cost_per_hour: 10000,
  default_energy_cost_per_hour: 5000,
  global_waste_percent: 3,
}

export function toProductionConfigDomain(
  entity: ProductionConfigEntity,
): ProductionConfigDomain {
  return {
    defaultMarginPercentage: entity.default_margin_percentage,
    currency: entity.currency,
    decimalPlaces: entity.decimal_places,
    priceRounding: entity.price_rounding,
    defaultIndirectCosts: entity.default_indirect_costs ?? [],
    taxPercentage: entity.tax_percentage,
    minimumProfitPercentage: entity.minimum_profit_percentage ?? 30,
    suggestedProfitPercentage: entity.suggested_profit_percentage ?? 80,
    premiumProfitPercentage: entity.premium_profit_percentage ?? 150,
    wholesaleProfitPercentage: entity.wholesale_profit_percentage ?? 20,
    distributorProfitPercentage: entity.distributor_profit_percentage ?? 15,
    psychologicalRounding: entity.psychological_rounding ?? 900,
    defaultLaborCostPerHour: entity.default_labor_cost_per_hour ?? 10000,
    defaultEnergyCostPerHour: entity.default_energy_cost_per_hour ?? 5000,
    globalWastePercent: entity.global_waste_percent ?? 3,
    updatedBy: (entity.updated_by as { toString?: () => string })?.toString?.(),
    updatedAt: entity.updated_at?.toISOString?.(),
  }
}

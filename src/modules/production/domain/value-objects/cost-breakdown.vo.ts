import type { UnitOfMeasure } from './unit-of-measure.vo.js'

export interface RecipeLineCost {
  materialId: string
  materialName: string
  unit: UnitOfMeasure
  quantity: number
  unitCost: number
  partialCost: number
}

export interface IndirectCostItem {
  name: string
  type: 'fixed' | 'percentage'
  value: number
  optional: boolean
  calculatedAmount: number
}

export interface CostBreakdown {
  lines: RecipeLineCost[]
  materialsCost: number
  indirectCosts: IndirectCostItem[]
  indirectCostTotal: number
  totalCost: number
  currency: string
}

export interface PriceSuggestion {
  totalCost: number
  marginPercentage: number
  suggestedPrice: number
  rounding: number
  currency: string
}

export function calculateCostBreakdown(
  lines: { materialId: string; materialName: string; unit: UnitOfMeasure; quantity: number; unitCost: number }[],
  indirectCosts: { name: string; type: 'fixed' | 'percentage'; value: number; optional: boolean }[],
  currency = 'COP',
): CostBreakdown {
  const calculatedLines: RecipeLineCost[] = lines.map((l) => {
    const partialCost = l.quantity * l.unitCost
    return {
      materialId: l.materialId,
      materialName: l.materialName,
      unit: l.unit,
      quantity: l.quantity,
      unitCost: l.unitCost,
      partialCost: round2(partialCost),
    }
  })

  const materialsCost = round2(calculatedLines.reduce((sum, l) => sum + l.partialCost, 0))

  const calculatedIndirect: IndirectCostItem[] = indirectCosts.map((ic) => {
    const calculatedAmount =
      ic.type === 'percentage' ? round2(materialsCost * (ic.value / 100)) : round2(ic.value)
    return { ...ic, calculatedAmount }
  })

  const indirectCostTotal = round2(calculatedIndirect.reduce((sum, ic) => sum + ic.calculatedAmount, 0))
  const totalCost = round2(materialsCost + indirectCostTotal)

  return {
    lines: calculatedLines,
    materialsCost,
    indirectCosts: calculatedIndirect,
    indirectCostTotal,
    totalCost,
    currency,
  }
}

export function calculateSuggestedPrice(
  totalCost: number,
  marginPercentage: number,
  rounding = 100,
  currency = 'COP',
): PriceSuggestion {
  const rawPrice = totalCost * (1 + marginPercentage / 100)
  const suggestedPrice = Math.ceil(rawPrice / rounding) * rounding
  return { totalCost, marginPercentage, suggestedPrice, rounding, currency }
}

export function calculateUnitCost(price: number, quantity: number): number {
  if (quantity <= 0) return 0
  return round2(price / quantity)
}

export interface ProfitSummary {
  salePrice: number
  totalCost: number
  profitPerUnit: number
  profitMarginPercent: number
}

export function calculateProfit(salePrice: number, totalCost: number): ProfitSummary {
  if (totalCost <= 0) throw new Error('El costo total debe ser mayor a 0')
  const profitPerUnit = salePrice - totalCost
  const profitMarginPercent = round2((profitPerUnit / totalCost) * 100)
  return {
    salePrice,
    totalCost,
    profitPerUnit: round2(profitPerUnit),
    profitMarginPercent,
  }
}

export interface PricingConfigInput {
  currency: string
  priceRounding: number
  psychologicalRounding: number
  taxPercentage?: number
  minimumProfitPercentage: number
  suggestedProfitPercentage: number
  premiumProfitPercentage: number
  wholesaleProfitPercentage: number
  distributorProfitPercentage: number
}

export interface PricingResult {
  costTotal: number
  costPerUnit: number
  marginPercentage: number
  rawPrice: number
  suggestedPrice: number
  psychologicalPrice: number
  profitAmount: number
  profitMarginPercent: number
  taxAmount?: number
  priceWithTax?: number
  currency: string
  rounding: number
}

const DEFAULT_SIMULATION_MARGINS = [20, 30, 40, 50, 60, 80, 100]

export function calculatePrice(
  costTotal: number,
  costPerUnit: number,
  marginPercentage: number,
  config: PricingConfigInput,
): PricingResult {
  if (marginPercentage < 0) throw new Error('El margen no puede ser negativo')
  if (config.priceRounding <= 0) throw new Error('El redondeo debe ser mayor a 0')

  const rawPrice = costPerUnit * (1 + marginPercentage / 100)
  const suggestedPrice = Math.ceil(rawPrice / config.priceRounding) * config.priceRounding
  const psychologicalPrice =
    config.psychologicalRounding > 0 && suggestedPrice >= config.psychologicalRounding
      ? Math.floor(suggestedPrice / config.psychologicalRounding) * config.psychologicalRounding
      : suggestedPrice

  const profitAmount = suggestedPrice - costTotal
  const profitMarginPercent = costTotal > 0 ? round2((profitAmount / costTotal) * 100) : 0

  let taxAmount: number | undefined
  let priceWithTax: number | undefined
  if (config.taxPercentage && config.taxPercentage > 0) {
    taxAmount = round2(suggestedPrice * (config.taxPercentage / 100))
    priceWithTax = suggestedPrice + taxAmount
  }

  return {
    costTotal,
    costPerUnit,
    marginPercentage,
    rawPrice: round2(rawPrice),
    suggestedPrice,
    psychologicalPrice,
    profitAmount: round2(profitAmount),
    profitMarginPercent,
    taxAmount,
    priceWithTax,
    currency: config.currency,
    rounding: config.priceRounding,
  }
}

export function simulateMargins(
  costPerUnit: number,
  config: PricingConfigInput,
  margins: number[] = DEFAULT_SIMULATION_MARGINS,
): PricingResult[] {
  return margins
    .filter((m) => m >= 0)
    .sort((a, b) => a - b)
    .map((margin) => calculatePrice(costPerUnit, costPerUnit, margin, config))
}

export function suggestMarginByLevel(
  costPerUnit: number,
  config: PricingConfigInput,
): { level: string; margin: number } {
  if (costPerUnit <= 0) return { level: 'minimum', margin: config.minimumProfitPercentage }
  if (costPerUnit < 10000) return { level: 'premium', margin: config.premiumProfitPercentage }
  if (costPerUnit < 50000) return { level: 'suggested', margin: config.suggestedProfitPercentage }
  if (costPerUnit < 200000) return { level: 'wholesale', margin: config.wholesaleProfitPercentage }
  return { level: 'distributor', margin: config.distributorProfitPercentage }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

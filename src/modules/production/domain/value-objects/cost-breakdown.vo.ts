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

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

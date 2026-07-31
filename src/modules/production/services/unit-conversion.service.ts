import { convertUnit, isConvertible, type UnitOfMeasure } from '../domain/value-objects/unit-of-measure.vo.js'
import type { UnitRepository } from '../infrastructure/unit.repository.js'

export class UnitConversionService {
  constructor(private readonly units: UnitRepository) {}

  async calculateCost(input: {
    price: number
    purchaseUnit: string
    recipeQuantity: number
    recipeUnit: string
  }): Promise<{ cost: number }> {
    const { price, purchaseUnit, recipeQuantity, recipeUnit } = input
    if (purchaseUnit === recipeUnit) {
      return { cost: price * recipeQuantity }
    }

    const from = purchaseUnit as UnitOfMeasure
    const to = recipeUnit as UnitOfMeasure
    if (isConvertible(from, to)) {
      const qtyInPurchaseUnit = convertUnit(recipeQuantity, to, from)
      return { cost: price * qtyInPurchaseUnit }
    }

    const fromUnit = await this.units.getByAbbreviation(purchaseUnit)
    const toUnit = await this.units.getByAbbreviation(recipeUnit)
    if (fromUnit && toUnit && fromUnit.family === toUnit.family && fromUnit.baseFactor > 0) {
      const baseQty = recipeQuantity * toUnit.baseFactor
      const qtyInPurchaseUnit = baseQty / fromUnit.baseFactor
      return { cost: price * qtyInPurchaseUnit }
    }

    return { cost: price * recipeQuantity }
  }

  async convert(input: { value: number; fromUnit: string; toUnit: string }): Promise<{ toValue: number }> {
    const from = input.fromUnit as UnitOfMeasure
    const to = input.toUnit as UnitOfMeasure
    if (isConvertible(from, to)) {
      return { toValue: convertUnit(input.value, from, to) }
    }

    const fromDef = await this.units.getByAbbreviation(input.fromUnit)
    const toDef = await this.units.getByAbbreviation(input.toUnit)
    if (fromDef && toDef && fromDef.family === toDef.family && fromDef.baseFactor > 0) {
      const base = input.value * toDef.baseFactor
      return { toValue: base / fromDef.baseFactor }
    }

    return { toValue: input.value }
  }
}

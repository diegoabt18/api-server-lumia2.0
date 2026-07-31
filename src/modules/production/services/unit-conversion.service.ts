import { convertUnit, isConvertible, type UnitOfMeasure } from '../domain/value-objects/unit-of-measure.vo.js'
import type { UnitRepository } from '../infrastructure/unit.repository.js'
import type { UnitConversionConfig, UnitEquivalenceRepository } from '../infrastructure/unit-equivalence.repository.js'

export class UnitConversionService {
  private config: UnitConversionConfig | null = null

  constructor(
    private readonly units: UnitRepository,
    private readonly equivalences?: UnitEquivalenceRepository,
  ) {}

  invalidateCache(): void {
    this.config = null
  }

  async getConfig(): Promise<UnitConversionConfig> {
    if (this.config) return this.config
    if (this.equivalences) {
      this.config = await this.equivalences.getConversionConfig()
      return this.config
    }
    const unitList = await this.units.list()
    this.config = {
      definitions: unitList.map((u) => ({
        id: u.id,
        name: u.name,
        abbreviation: u.abbreviation,
        family: u.family,
        baseFactor: u.baseFactor,
        active: u.active,
        sortOrder: u.sortOrder,
      })),
      equivalences: [],
    }
    return this.config
  }

  async validateFamily(unitA: string, unitB: string): Promise<{ valid: boolean; family?: string; error?: string }> {
    const config = await this.getConfig()
    const findDef = (id: string) =>
      config.definitions.find((d) => d.id === id || d.abbreviation === id)
    const defA = findDef(unitA)
    const defB = findDef(unitB)
    if (!defA || !defB) {
      return { valid: false, error: 'Una o ambas unidades no encontradas' }
    }
    if (defA.family !== defB.family) {
      return { valid: false, error: `Familias incompatibles: ${defA.family} vs ${defB.family}` }
    }
    return { valid: true, family: defA.family }
  }

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

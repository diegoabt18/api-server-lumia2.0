/**
 * Conversiones UNIVERSALES entre unidades físicas.
 * Espejo de lumia/shared/production/unit-cost-engine — mantener sincronizado.
 */

export type PhysicalFamily = 'mass' | 'volume' | 'length' | 'area'

export type PhysicalUnitId =
  | 'kg'
  | 'g'
  | 'mg'
  | 'l'
  | 'ml'
  | 'm'
  | 'cm'
  | 'mm'
  | 'm2'
  | 'cm2'

export const PHYSICAL_UNITS: Record<
  PhysicalUnitId,
  { family: PhysicalFamily; toBase: number; label: string }
> = {
  kg: { family: 'mass', toBase: 1, label: 'Kilogramo' },
  g: { family: 'mass', toBase: 0.001, label: 'Gramo' },
  mg: { family: 'mass', toBase: 0.000001, label: 'Miligramo' },
  l: { family: 'volume', toBase: 1, label: 'Litro' },
  ml: { family: 'volume', toBase: 0.001, label: 'Mililitro' },
  m: { family: 'length', toBase: 1, label: 'Metro' },
  cm: { family: 'length', toBase: 0.01, label: 'Centímetro' },
  mm: { family: 'length', toBase: 0.001, label: 'Milímetro' },
  m2: { family: 'area', toBase: 1, label: 'Metro cuadrado' },
  cm2: { family: 'area', toBase: 0.0001, label: 'Centímetro cuadrado' },
}

export const PHYSICAL_UNIT_IDS = Object.keys(PHYSICAL_UNITS) as PhysicalUnitId[]

export function isPhysicalUnit(unit: string): unit is PhysicalUnitId {
  return unit in PHYSICAL_UNITS
}

export function getPhysicalFamily(unit: string): PhysicalFamily | null {
  if (!isPhysicalUnit(unit)) return null
  return PHYSICAL_UNITS[unit].family
}

export class UnitConversionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnitConversionError'
  }
}

export function convertPhysical(quantity: number, fromUnit: string, toUnit: string): number {
  if (fromUnit === toUnit) return quantity
  if (!Number.isFinite(quantity)) {
    throw new UnitConversionError('La cantidad debe ser un número finito')
  }
  if (quantity === 0) return 0

  if (!isPhysicalUnit(fromUnit) || !isPhysicalUnit(toUnit)) {
    throw new UnitConversionError(
      `No se puede convertir "${fromUnit}" a "${toUnit}" con reglas físicas universales.`,
    )
  }

  const from = PHYSICAL_UNITS[fromUnit]
  const to = PHYSICAL_UNITS[toUnit]
  if (from.family !== to.family) {
    throw new UnitConversionError(
      `No se puede convertir ${fromUnit} a ${toUnit} porque pertenecen a familias diferentes (${from.family} ≠ ${to.family}).`,
    )
  }

  const inBase = quantity * from.toBase
  const result = inBase / to.toBase
  return Math.round(result * 1_000_000_000) / 1_000_000_000
}

export function assertSamePhysicalFamily(a: string, b: string): void {
  const fa = getPhysicalFamily(a)
  const fb = getPhysicalFamily(b)
  if (!fa || !fb || fa !== fb) {
    throw new UnitConversionError(
      `No se puede convertir ${a} a ${b} porque pertenecen a familias diferentes.`,
    )
  }
}

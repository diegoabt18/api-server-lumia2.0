export const UNIT_OF_MEASURE = {
  KILOGRAM: 'kg',
  GRAM: 'g',
  MILLIGRAM: 'mg',
  LITER: 'l',
  MILLILITER: 'ml',
  METER: 'm',
  CENTIMETER: 'cm',
  MILLIMETER: 'mm',
  SQUARE_METER: 'm2',
  SQUARE_CENTIMETER: 'cm2',
  UNIT: 'unidad',
  PLIEGO: 'pliego',
  ROLL: 'rollo',
  BOX: 'caja',
  BAG: 'bolsa',
  PACK: 'paquete',
  OTHER: 'otro',
} as const

export type UnitOfMeasure = (typeof UNIT_OF_MEASURE)[keyof typeof UNIT_OF_MEASURE]

export const ALL_UNITS: UnitOfMeasure[] = Object.values(UNIT_OF_MEASURE)

const CONVERSION_GROUPS: Record<string, { unit: UnitOfMeasure; toBase: number }[]> = {
  mass: [
    { unit: UNIT_OF_MEASURE.KILOGRAM, toBase: 1 },
    { unit: UNIT_OF_MEASURE.GRAM, toBase: 0.001 },
    { unit: UNIT_OF_MEASURE.MILLIGRAM, toBase: 0.000001 },
  ],
  volume: [
    { unit: UNIT_OF_MEASURE.LITER, toBase: 1 },
    { unit: UNIT_OF_MEASURE.MILLILITER, toBase: 0.001 },
  ],
  length: [
    { unit: UNIT_OF_MEASURE.METER, toBase: 1 },
    { unit: UNIT_OF_MEASURE.CENTIMETER, toBase: 0.01 },
    { unit: UNIT_OF_MEASURE.MILLIMETER, toBase: 0.001 },
  ],
  area: [
    { unit: UNIT_OF_MEASURE.SQUARE_METER, toBase: 1 },
    { unit: UNIT_OF_MEASURE.SQUARE_CENTIMETER, toBase: 0.0001 },
  ],
}

function findConversionGroup(unit: UnitOfMeasure): string | null {
  for (const [group, members] of Object.entries(CONVERSION_GROUPS)) {
    if (members.some((m) => m.unit === unit)) return group
  }
  return null
}

function getConversionFactor(unit: UnitOfMeasure): number {
  for (const members of Object.values(CONVERSION_GROUPS)) {
    const found = members.find((m) => m.unit === unit)
    if (found) return found.toBase
  }
  return 1
}

export function convertUnit(value: number, from: UnitOfMeasure, to: UnitOfMeasure): number {
  if (from === to) return value
  const groupFrom = findConversionGroup(from)
  const groupTo = findConversionGroup(to)
  if (!groupFrom || !groupTo || groupFrom !== groupTo) return value
  const result = (value * getConversionFactor(from)) / getConversionFactor(to)
  return Math.round(result * 1_000_000) / 1_000_000
}

export function isConvertible(from: UnitOfMeasure, to: UnitOfMeasure): boolean {
  if (from === to) return true
  const g1 = findConversionGroup(from)
  const g2 = findConversionGroup(to)
  return g1 !== null && g2 !== null && g1 === g2
}

export type UnitFamilyId = 'mass' | 'volume' | 'length' | 'area' | 'count' | 'other'

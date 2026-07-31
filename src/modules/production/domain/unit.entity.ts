import type { UnitFamilyId } from './value-objects/unit-of-measure.vo.js'

export interface UnitEntity {
  _id?: unknown
  name: string
  abbreviation: string
  family: UnitFamilyId
  base_factor: number
  active: boolean
  sort_order: number
  created_at: Date
  updated_at: Date
}

export interface UnitDomain {
  id: string
  name: string
  abbreviation: string
  family: UnitFamilyId
  baseFactor: number
  active: boolean
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export function toUnitDomain(entity: UnitEntity & { _id?: { toString(): string } }): UnitDomain {
  return {
    id: entity._id?.toString?.() ?? '',
    name: entity.name,
    abbreviation: entity.abbreviation,
    family: entity.family,
    baseFactor: entity.base_factor,
    active: entity.active,
    sortOrder: entity.sort_order,
    createdAt: entity.created_at?.toISOString?.() ?? '',
    updatedAt: entity.updated_at?.toISOString?.() ?? '',
  }
}

export const DEFAULT_UNITS: Omit<UnitEntity, '_id' | 'created_at' | 'updated_at'>[] = [
  { name: 'Kilogramo', abbreviation: 'kg', family: 'mass', base_factor: 1, active: true, sort_order: 1 },
  { name: 'Gramo', abbreviation: 'g', family: 'mass', base_factor: 0.001, active: true, sort_order: 2 },
  { name: 'Miligramo', abbreviation: 'mg', family: 'mass', base_factor: 0.000001, active: true, sort_order: 3 },
  { name: 'Litro', abbreviation: 'l', family: 'volume', base_factor: 1, active: true, sort_order: 4 },
  { name: 'Mililitro', abbreviation: 'ml', family: 'volume', base_factor: 0.001, active: true, sort_order: 5 },
  { name: 'Metro', abbreviation: 'm', family: 'length', base_factor: 1, active: true, sort_order: 6 },
  { name: 'Centímetro', abbreviation: 'cm', family: 'length', base_factor: 0.01, active: true, sort_order: 7 },
  { name: 'Milímetro', abbreviation: 'mm', family: 'length', base_factor: 0.001, active: true, sort_order: 8 },
  { name: 'Metro cuadrado', abbreviation: 'm2', family: 'area', base_factor: 1, active: true, sort_order: 9 },
  { name: 'Centímetro cuadrado', abbreviation: 'cm2', family: 'area', base_factor: 0.0001, active: true, sort_order: 10 },
  { name: 'Unidad', abbreviation: 'unidad', family: 'count', base_factor: 1, active: true, sort_order: 11 },
  { name: 'Caja', abbreviation: 'caja', family: 'count', base_factor: 1, active: true, sort_order: 12 },
  { name: 'Bolsa', abbreviation: 'bolsa', family: 'count', base_factor: 1, active: true, sort_order: 13 },
  { name: 'Paquete', abbreviation: 'paquete', family: 'count', base_factor: 1, active: true, sort_order: 14 },
  { name: 'Rollo', abbreviation: 'rollo', family: 'count', base_factor: 1, active: true, sort_order: 15 },
  { name: 'Pliego', abbreviation: 'pliego', family: 'count', base_factor: 1, active: true, sort_order: 16 },
]

export interface UnitEquivalenceEntity {
  _id?: unknown
  from_unit_id: string
  to_unit_id: string
  factor: number
  description?: string
  active: boolean
  created_at: Date
  updated_at: Date
}

export interface UnitEquivalenceDomain {
  id: string
  fromUnitId: string
  toUnitId: string
  factor: number
  description?: string
  active: boolean
  createdAt: string
  updatedAt: string
}

export function toUnitEquivalenceDomain(
  entity: UnitEquivalenceEntity & { _id?: { toString(): string } },
): UnitEquivalenceDomain {
  return {
    id: entity._id?.toString?.() ?? '',
    fromUnitId: entity.from_unit_id,
    toUnitId: entity.to_unit_id,
    factor: entity.factor,
    description: entity.description,
    active: entity.active ?? true,
    createdAt: entity.created_at?.toISOString?.() ?? '',
    updatedAt: entity.updated_at?.toISOString?.() ?? '',
  }
}

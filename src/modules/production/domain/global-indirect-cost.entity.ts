export type IndirectCostAllocation = 'per_unit' | 'per_batch' | 'per_hour' | 'percentage' | 'per_direct_cost'

export interface GlobalIndirectCostEntity {
  _id?: unknown
  name: string
  allocation_type: IndirectCostAllocation
  value: number
  active: boolean
  notes?: string
  created_at: Date
  updated_at: Date
}

export interface GlobalIndirectCostDomain {
  id: string
  name: string
  allocationType: IndirectCostAllocation
  value: number
  active: boolean
  notes?: string
  createdAt: string
  updatedAt: string
}

export function toGlobalIndirectCostDomain(
  entity: GlobalIndirectCostEntity & { _id?: { toString(): string } },
): GlobalIndirectCostDomain {
  return {
    id: entity._id?.toString?.() ?? '',
    name: entity.name,
    allocationType: entity.allocation_type,
    value: entity.value,
    active: entity.active ?? true,
    notes: entity.notes,
    createdAt: entity.created_at?.toISOString?.() ?? '',
    updatedAt: entity.updated_at?.toISOString?.() ?? '',
  }
}

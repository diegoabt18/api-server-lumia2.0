export type ServiceCostType = 'fixed' | 'per_unit' | 'per_batch'

export interface ServiceItemEntity {
  name: string
  type: ServiceCostType
  value: number
  notes?: string
}

export interface ServiceCostEntity {
  _id?: unknown
  recipe_id: unknown
  items: ServiceItemEntity[]
  created_at: Date
  updated_at: Date
}

export interface ServiceCostDomain {
  id: string
  recipeId: string
  items: { name: string; type: ServiceCostType; value: number; notes?: string }[]
  createdAt: string
  updatedAt: string
}

export function toServiceCostDomain(
  entity: ServiceCostEntity & { _id?: { toString(): string } },
): ServiceCostDomain {
  return {
    id: entity._id?.toString?.() ?? '',
    recipeId: (entity.recipe_id as { toString?: () => string })?.toString?.() ?? '',
    items: (entity.items ?? []).map((i) => ({
      name: i.name,
      type: i.type,
      value: i.value,
      notes: i.notes,
    })),
    createdAt: entity.created_at?.toISOString?.() ?? '',
    updatedAt: entity.updated_at?.toISOString?.() ?? '',
  }
}

export function buildServiceCostEntity(
  recipeId: string,
  items: { name: string; type: ServiceCostType; value: number; notes?: string }[],
): Omit<ServiceCostEntity, '_id'> {
  const now = new Date()
  return {
    recipe_id: recipeId,
    items: items.map((i) => ({ name: i.name, type: i.type, value: i.value, notes: i.notes })),
    created_at: now,
    updated_at: now,
  }
}

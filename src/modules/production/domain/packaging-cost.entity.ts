export type PackagingType = 'optional' | 'mandatory' | 'by_variant'

export interface PackagingItemEntity {
  name: string
  type: PackagingType
  unit: string
  quantity: number
  unit_cost: number
  total: number
}

export interface PackagingCostEntity {
  _id?: unknown
  recipe_id: unknown
  items: PackagingItemEntity[]
  created_at: Date
  updated_at: Date
}

export interface PackagingCostDomain {
  id: string
  recipeId: string
  items: {
    name: string
    type: PackagingType
    unit: string
    quantity: number
    unitCost: number
    total: number
  }[]
  createdAt: string
  updatedAt: string
}

export function toPackagingCostDomain(
  entity: PackagingCostEntity & { _id?: { toString(): string } },
): PackagingCostDomain {
  return {
    id: entity._id?.toString?.() ?? '',
    recipeId: (entity.recipe_id as { toString?: () => string })?.toString?.() ?? '',
    items: (entity.items ?? []).map((i) => ({
      name: i.name,
      type: i.type,
      unit: i.unit,
      quantity: i.quantity,
      unitCost: i.unit_cost,
      total: i.total,
    })),
    createdAt: entity.created_at?.toISOString?.() ?? '',
    updatedAt: entity.updated_at?.toISOString?.() ?? '',
  }
}

export function buildPackagingCostEntity(
  recipeId: string,
  items: { name: string; type: PackagingType; unit: string; quantity: number; unitCost: number }[],
): Omit<PackagingCostEntity, '_id'> {
  const now = new Date()
  return {
    recipe_id: recipeId,
    items: items.map((i) => ({
      name: i.name,
      type: i.type,
      unit: i.unit,
      quantity: i.quantity,
      unit_cost: i.unitCost,
      total: Math.round(i.quantity * i.unitCost * 100) / 100,
    })),
    created_at: now,
    updated_at: now,
  }
}

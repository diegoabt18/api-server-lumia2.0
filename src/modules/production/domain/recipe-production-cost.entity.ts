export interface RecipeProductionCostItemEntity {
  name: string
  type: 'fixed' | 'per_minute' | 'per_hour' | 'per_batch' | 'per_unit'
  value: number
  active: boolean
}

export interface RecipeProductionCostEntity {
  _id?: unknown
  recipe_id: unknown
  items: RecipeProductionCostItemEntity[]
  created_at: Date
  updated_at: Date
}

export interface RecipeProductionCostDomain {
  id: string
  recipeId: string
  items: {
    name: string
    type: 'fixed' | 'per_minute' | 'per_hour' | 'per_batch' | 'per_unit'
    value: number
    active: boolean
  }[]
  createdAt: string
  updatedAt: string
}

export function toRecipeProductionCostDomain(
  entity: RecipeProductionCostEntity & { _id?: { toString(): string } },
): RecipeProductionCostDomain {
  return {
    id: entity._id?.toString?.() ?? '',
    recipeId: (entity.recipe_id as { toString?: () => string })?.toString?.() ?? '',
    items: (entity.items ?? []).map((i) => ({
      name: i.name,
      type: i.type,
      value: i.value,
      active: i.active,
    })),
    createdAt: entity.created_at?.toISOString?.() ?? '',
    updatedAt: entity.updated_at?.toISOString?.() ?? '',
  }
}

export function buildRecipeProductionCostEntity(
  recipeId: string,
  items: { name: string; type: RecipeProductionCostItemEntity['type']; value: number; active?: boolean }[],
): Omit<RecipeProductionCostEntity, '_id'> {
  const now = new Date()
  return {
    recipe_id: recipeId,
    items: items.map((i) => ({ name: i.name, type: i.type, value: i.value, active: i.active ?? true })),
    created_at: now,
    updated_at: now,
  }
}

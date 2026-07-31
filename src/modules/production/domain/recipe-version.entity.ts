export interface RecipeVersionEntity {
  _id?: unknown
  recipe_id: unknown
  version: number
  lines: unknown[]
  indirect_costs: unknown[]
  materials_cost: number
  indirect_cost: number
  total_cost: number
  changes_description: string
  changed_by?: unknown
  created_at: Date
}

export interface RecipeVersionDomain {
  id: string
  recipeId: string
  version: number
  materialsCost: number
  indirectCost: number
  totalCost: number
  changesDescription: string
  changedBy?: string
  createdAt: string
}

export function toRecipeVersionDomain(
  entity: RecipeVersionEntity & { _id?: { toString(): string } },
): RecipeVersionDomain {
  return {
    id: entity._id?.toString?.() ?? '',
    recipeId: (entity.recipe_id as { toString?: () => string })?.toString?.() ?? '',
    version: entity.version,
    materialsCost: entity.materials_cost,
    indirectCost: entity.indirect_cost,
    totalCost: entity.total_cost,
    changesDescription: entity.changes_description,
    changedBy: (entity.changed_by as { toString?: () => string })?.toString?.(),
    createdAt: entity.created_at?.toISOString?.() ?? '',
  }
}

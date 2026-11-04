/** Estado de sincronización precio tienda ↔ receta de producción. */
export type ProductRepostStatus =
  | 'no_recipe'
  | 'up_to_date'
  | 'needs_repost'
  | 'pending_approval'
  | 'mixed'

export interface VariantRepostContext {
  sku: string
  hasRecipe: boolean
  recipeId?: string | null
  recipeVersion?: number | null
  recipeCostsOutdated?: boolean
  lastPublishedRecipeVersion?: number | null
  costStatus?: string | null
  hasPendingApproval?: boolean
}

export function resolveVariantRepostStatus(v: VariantRepostContext): ProductRepostStatus {
  if (!v.hasRecipe || !v.recipeId) return 'no_recipe'
  if (v.hasPendingApproval) return 'pending_approval'

  const costStale = v.costStatus === 'outdated' || v.costStatus === 'pending_recalculation'
  const neverPublished = v.recipeVersion != null && v.lastPublishedRecipeVersion == null
  const recipeVersionChanged =
    v.recipeVersion != null
    && v.lastPublishedRecipeVersion != null
    && v.lastPublishedRecipeVersion < v.recipeVersion

  if (v.recipeCostsOutdated || costStale || neverPublished || recipeVersionChanged) {
    return 'needs_repost'
  }

  return 'up_to_date'
}

export function resolveProductRepostStatus(variants: VariantRepostContext[]): ProductRepostStatus {
  if (!variants.length) return 'no_recipe'

  const statuses = variants.map(resolveVariantRepostStatus)
  if (statuses.every((s) => s === 'no_recipe')) return 'no_recipe'
  if (statuses.every((s) => s === 'up_to_date' || s === 'no_recipe')) return 'up_to_date'

  const actionable = statuses.filter((s) => s !== 'no_recipe')
  if (actionable.every((s) => s === 'pending_approval')) return 'pending_approval'
  if (actionable.some((s) => s === 'needs_repost')) return 'needs_repost'

  return 'mixed'
}

export function countVariantsNeedingRepost(variants: VariantRepostContext[]): number {
  return variants.filter((v) => resolveVariantRepostStatus(v) === 'needs_repost').length
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'published'

/**
 * Base del precio sugerido de la solicitud.
 * - `tax_included`: `suggested_price` es el precio final con el IVA del producto (`tax_rate`).
 * - `legacy`: solicitudes anteriores, con el precio sin IVA; no se pueden publicar.
 */
export type PriceBasis = 'tax_included' | 'legacy'

export interface PriceApprovalEntity {
  _id?: unknown
  variant_sku: string
  product_slug: string
  product_name?: string
  previous_cost: number
  new_cost: number
  materials_cost: number
  previous_price: number
  suggested_price: number
  /** Base sin IVA del precio sugerido (solo `price_basis: 'tax_included'`). */
  suggested_price_net?: number
  /** IVA del producto (%) usado al crear la solicitud. */
  tax_rate?: number
  price_basis?: 'tax_included'
  margin_percentage: number
  currency: string
  status: ApprovalStatus
  cost_sheet_id?: unknown
  recipe_id?: unknown
  recipe_version: number
  snapshot_id?: unknown
  created_by?: unknown
  approved_by?: unknown
  rejected_by?: unknown
  rejected_reason?: string
  published_by?: unknown
  published_at?: Date
  created_at: Date
  updated_at: Date
}

export interface PriceApprovalDomain {
  id: string
  variantSku: string
  productSlug: string
  productName?: string
  previousCost: number
  newCost: number
  materialsCost: number
  previousPrice: number
  suggestedPrice: number
  suggestedPriceNet?: number
  taxRate?: number
  priceBasis: PriceBasis
  marginPercentage: number
  currency: string
  status: ApprovalStatus
  costSheetId?: string
  recipeId?: string
  recipeVersion: number
  snapshotId?: string
  createdBy?: string
  approvedBy?: string
  rejectedBy?: string
  rejectedReason?: string
  publishedBy?: string
  publishedAt?: string
  createdAt: string
  updatedAt: string
}

export function toPriceApprovalDomain(
  entity: PriceApprovalEntity & { _id?: { toString(): string } },
): PriceApprovalDomain {
  return {
    id: entity._id?.toString?.() ?? '',
    variantSku: entity.variant_sku,
    productSlug: entity.product_slug,
    productName: entity.product_name,
    previousCost: entity.previous_cost,
    newCost: entity.new_cost,
    materialsCost: entity.materials_cost ?? 0,
    previousPrice: entity.previous_price,
    suggestedPrice: entity.suggested_price,
    suggestedPriceNet: entity.suggested_price_net,
    taxRate: entity.tax_rate,
    priceBasis: entity.price_basis === 'tax_included' ? 'tax_included' : 'legacy',
    marginPercentage: entity.margin_percentage,
    currency: entity.currency,
    status: entity.status,
    costSheetId: (entity.cost_sheet_id as { toString?: () => string })?.toString?.(),
    recipeId: (entity.recipe_id as { toString?: () => string })?.toString?.(),
    recipeVersion: entity.recipe_version,
    snapshotId: (entity.snapshot_id as { toString?: () => string })?.toString?.(),
    createdBy: (entity.created_by as { toString?: () => string })?.toString?.(),
    approvedBy: (entity.approved_by as { toString?: () => string })?.toString?.(),
    rejectedBy: (entity.rejected_by as { toString?: () => string })?.toString?.(),
    rejectedReason: entity.rejected_reason,
    publishedBy: (entity.published_by as { toString?: () => string })?.toString?.(),
    publishedAt: entity.published_at?.toISOString?.(),
    createdAt: entity.created_at?.toISOString?.() ?? '',
    updatedAt: entity.updated_at?.toISOString?.() ?? '',
  }
}

export function approvePriceApprovalPatch(userId: string): Partial<PriceApprovalEntity> {
  return { status: 'approved', approved_by: userId, updated_at: new Date() }
}

export function rejectPriceApprovalPatch(userId: string, reason: string): Partial<PriceApprovalEntity> {
  return { status: 'rejected', rejected_by: userId, rejected_reason: reason, updated_at: new Date() }
}

export function publishPriceApprovalPatch(userId: string): Partial<PriceApprovalEntity> {
  return { status: 'published', published_by: userId, published_at: new Date(), updated_at: new Date() }
}

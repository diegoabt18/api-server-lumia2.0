export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'published'

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

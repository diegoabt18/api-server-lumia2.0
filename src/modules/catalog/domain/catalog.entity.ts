import type { DepositPolicy } from './deposit-policy.js'

export interface ProductEntity {
  _id?: unknown
  name: string
  slug: string
  /** Tasa de IVA en porcentaje (0-100). null = no configurada; nunca se asume un valor. */
  tax_rate?: number | null
  description?: string
  /** Derivado de la subcategoría (ver ProductService). No se escribe libremente. */
  category_slug?: string
  /** Subcategoría obligatoria para productos nuevos. Ausente = producto pendiente de clasificar (legacy). */
  subcategory_id?: unknown
  brand?: string
  status?: 'active' | 'inactive'
  created_at?: Date
  updated_at?: Date
  image_path?: string
  sales_total_units?: number
  sales_order_count?: number
  popularity_score?: number
  last_purchased_at?: Date
  /** Resumen denormalizado de reseñas visibles (lo mantiene FeedbackService / db:recalculate-ratings). */
  average_rating?: number
  reviews_count?: number
}

export interface VariantEntity {
  _id?: unknown
  product_slug: string
  sku: string
  /** Código de barras EAN/UPC/GTIN. Único por variante cuando está presente. */
  barcode?: string | null
  description?: string
  options?: Record<string, string>
  option_value_ids?: unknown[]
  option_rules?: Array<{ option_id: unknown; allowed_value_ids?: unknown[] }>
  price: number
  currency: string
  compare_at_price?: number
  image_path?: string
  created_at?: Date
  production_recipe_id?: unknown
  pricing_status?: string
  cost_status?: string
  suggested_price?: number
  production_data?: Record<string, unknown>
}

export interface InventoryItemEntity {
  sku: string
  quantity: number
  reserved: number
  warehouse: string
  is_per_order: boolean
  /** Política de anticipo (solo SKUs por pedido). Ausente o null = no configurada. */
  deposit_policy?: DepositPolicy | null
  /** Versión de control optimista de la política (G3). */
  deposit_policy_version?: number
  updated_at?: Date
}

export type CatalogStatus = 'active' | 'inactive'

export interface CategoryEntity {
  _id?: unknown
  name: string
  slug: string
  description?: string | null
  image_path?: string | null
  /** Ausente en documentos legacy = activo. */
  status?: CatalogStatus
  sort_order?: number
  createdAt?: Date
  updatedAt?: Date
}

export interface SubcategoryEntity {
  _id?: unknown
  category_id: unknown
  name: string
  slug: string
  description?: string | null
  image_path?: string | null
  status?: CatalogStatus
  sort_order?: number
  created_at?: Date
  updated_at?: Date
}

export interface ProductDomain {
  id: string
  name: string
  slug: string
  taxRate?: number | null
  description?: string
  categorySlug?: string
  subcategoryId?: string | null
  brand?: string
  status?: 'active' | 'inactive'
  createdAt?: string
  updatedAt?: string
  imagePath?: string
  salesTotalUnits?: number
  salesOrderCount?: number
  popularityScore?: number
  lastPurchasedAt?: string
  averageRating?: number
  reviewsCount?: number
}

export interface VariantDomain {
  id?: string
  sku: string
  productSlug: string
  barcode?: string | null
  description?: string
  options: Record<string, string>
  optionValueIds?: string[]
  optionRules?: Array<{ optionId: string; allowedValueIds: string[] }>
  price: number
  currency: string
  compareAtPrice?: number
  imagePath?: string
  stock: number
  reserved: number
  available: number
  inventory?: Array<{
    sku: string
    quantity: number
    reserved: number
    warehouse: string
    is_per_order: boolean
    updatedAt: string
  }>
  productionRecipeId?: string | null
  pricingStatus?: string | null
  costStatus?: string | null
  suggestedPrice?: number | null
  productionData?: Record<string, unknown> | null
}

export interface ProductWithVariants extends ProductDomain {
  variants: VariantDomain[]
  fromPrice?: number
}

export interface CategoryDomain {
  id: string
  name: string
  slug: string
  description: string | null
  imagePath: string | null
  status: CatalogStatus
  sortOrder: number
  createdAt: string
  updatedAt: string | null
}

export interface SubcategoryDomain {
  id: string
  categoryId: string
  name: string
  slug: string
  description: string | null
  imagePath: string | null
  status: CatalogStatus
  sortOrder: number
  createdAt: string
  updatedAt: string | null
}

function parseDate(v: unknown): Date | undefined {
  if (v == null) return undefined
  if (v instanceof Date) return v
  const d = new Date(String(v))
  return Number.isNaN(d.getTime()) ? undefined : d
}

export function toProductDomain(e: ProductEntity): ProductDomain {
  const created = parseDate(e.created_at)
  const updated = parseDate(e.updated_at)
  return {
    id: String(e._id),
    name: e.name,
    slug: e.slug,
    taxRate: e.tax_rate ?? null,
    description: e.description,
    categorySlug: e.category_slug,
    subcategoryId: e.subcategory_id != null ? String(e.subcategory_id) : null,
    brand: e.brand,
    status: e.status,
    createdAt: created?.toISOString(),
    updatedAt: updated?.toISOString(),
    imagePath: e.image_path,
    salesTotalUnits: typeof e.sales_total_units === 'number' ? e.sales_total_units : undefined,
    salesOrderCount: typeof e.sales_order_count === 'number' ? e.sales_order_count : undefined,
    popularityScore: typeof e.popularity_score === 'number' ? e.popularity_score : undefined,
    lastPurchasedAt:
      e.last_purchased_at instanceof Date ? e.last_purchased_at.toISOString() : undefined,
    averageRating: typeof e.average_rating === 'number' ? e.average_rating : undefined,
    reviewsCount: typeof e.reviews_count === 'number' ? e.reviews_count : undefined,
  }
}

export function toCategoryDomain(e: CategoryEntity): CategoryDomain {
  const created = parseDate(e.createdAt) ?? new Date()
  const updated = parseDate(e.updatedAt)
  return {
    id: String(e._id),
    name: e.name,
    slug: e.slug,
    description: e.description ?? null,
    imagePath: e.image_path ?? null,
    status: e.status === 'inactive' ? 'inactive' : 'active',
    sortOrder: typeof e.sort_order === 'number' ? e.sort_order : 0,
    createdAt: created.toISOString(),
    updatedAt: updated?.toISOString() ?? null,
  }
}

export function toSubcategoryDomain(e: SubcategoryEntity): SubcategoryDomain {
  const created = parseDate(e.created_at) ?? new Date()
  const updated = parseDate(e.updated_at)
  return {
    id: String(e._id),
    categoryId: String(e.category_id),
    name: e.name,
    slug: e.slug,
    description: e.description ?? null,
    imagePath: e.image_path ?? null,
    status: e.status === 'inactive' ? 'inactive' : 'active',
    sortOrder: typeof e.sort_order === 'number' ? e.sort_order : 0,
    createdAt: created.toISOString(),
    updatedAt: updated?.toISOString() ?? null,
  }
}

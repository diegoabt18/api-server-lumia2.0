export interface ProductEntity {
  _id?: unknown
  name: string
  slug: string
  description?: string
  category_slug?: string
  brand?: string
  status?: 'active' | 'inactive'
  created_at?: Date
  updated_at?: Date
  image_path?: string
  sales_total_units?: number
  sales_order_count?: number
  popularity_score?: number
  last_purchased_at?: Date
}

export interface VariantEntity {
  _id?: unknown
  product_slug: string
  sku: string
  description?: string
  options?: Record<string, string>
  price: number
  currency: string
  compare_at_price?: number
  image_path?: string
  created_at?: Date
  production_recipe_id?: unknown
}

export interface InventoryItemEntity {
  sku: string
  quantity: number
  reserved: number
  warehouse: string
  is_per_order: boolean
  updated_at?: Date
}

export interface CategoryEntity {
  _id?: unknown
  name: string
  slug: string
  createdAt?: Date
}

export interface ProductDomain {
  id: string
  name: string
  slug: string
  description?: string
  categorySlug?: string
  brand?: string
  status?: 'active' | 'inactive'
  createdAt?: string
  updatedAt?: string
  imagePath?: string
  salesTotalUnits?: number
  salesOrderCount?: number
  popularityScore?: number
  lastPurchasedAt?: string
}

export interface VariantDomain {
  sku: string
  productSlug: string
  description?: string
  options: Record<string, string>
  price: number
  currency: string
  compareAtPrice?: number
  imagePath?: string
  stock: number
  reserved: number
  available: number
}

export interface ProductWithVariants extends ProductDomain {
  variants: VariantDomain[]
  fromPrice?: number
}

export interface CategoryDomain {
  id: string
  name: string
  slug: string
  createdAt: string
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
    description: e.description,
    categorySlug: e.category_slug,
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
  }
}

export function toCategoryDomain(e: CategoryEntity): CategoryDomain {
  const created = parseDate(e.createdAt) ?? new Date()
  return {
    id: String(e._id),
    name: e.name,
    slug: e.slug,
    createdAt: created.toISOString(),
  }
}

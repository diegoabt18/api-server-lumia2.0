import { AppError } from '../../../common/errors/app.error.js'
import { buildPaginationMeta, resolvePagingQuery } from '../../../common/utils/pagination.js'
import type { ProductRepository } from '../../catalog/infrastructure/product.repository.js'
import type { CategoryRepository } from '../../catalog/infrastructure/category.repository.js'
import type { SubcategoryRepository } from '../../catalog/infrastructure/subcategory.repository.js'
import type { CatalogOptionRepository } from '../../catalog/infrastructure/catalog-option.repository.js'
import { resolveProductHierarchyFilter } from '../../catalog/services/catalog-hierarchy.js'
import type { ProductDomain, VariantDomain } from '../../catalog/domain/catalog.entity.js'

/** Nombres derivados de la jerarquía, para mostrar en la administración (nunca se guardan en el producto). */
export interface ProductHierarchyLabels {
  categoryId?: string | null
  categoryName?: string | null
  subcategoryName?: string | null
}

function serializeProduct(p: ProductDomain, labels: ProductHierarchyLabels = {}) {
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    taxRate: p.taxRate ?? null,
    description: p.description ?? null,
    categorySlug: p.categorySlug ?? null,
    categoryId: labels.categoryId ?? null,
    categoryName: labels.categoryName ?? null,
    subcategoryId: p.subcategoryId ?? null,
    subcategoryName: labels.subcategoryName ?? null,
    brand: p.brand ?? null,
    status: p.status ?? 'active',
    createdAt: p.createdAt ?? null,
    updatedAt: p.updatedAt ?? null,
    imagePath: p.imagePath ?? null,
  }
}

function labelsFor(
  subcategoryId: string | null | undefined,
  subMap: Map<string, { name: string; categoryId: string }>,
  catMap: Map<string, { name: string }>,
): ProductHierarchyLabels {
  if (!subcategoryId) return {}
  const sub = subMap.get(subcategoryId)
  if (!sub) return {}
  return {
    categoryId: sub.categoryId,
    categoryName: catMap.get(sub.categoryId)?.name ?? null,
    subcategoryName: sub.name,
  }
}

function serializeAdminVariant(v: VariantDomain) {
  const optionValueIds = v.optionValueIds ?? []
  const productionRecipeId = v.productionRecipeId ?? null
  return {
    id: v.id ?? v.sku,
    sku: v.sku,
    barcode: v.barcode ?? null,
    price: v.price,
    currency: v.currency,
    options: v.options ?? {},
    optionValueIds,
    optionRules: v.optionRules ?? [],
    compareAtPrice: v.compareAtPrice ?? null,
    imagePath: v.imagePath ?? null,
    combinationKey: optionValueIds.length ? [...optionValueIds].sort().join('|') : null,
    stock: v.stock,
    reserved: v.reserved,
    available: v.available,
    inventory: v.inventory ?? [],
    production_recipe_id: productionRecipeId,
    productionRecipeId,
    pricing_status: v.pricingStatus ?? null,
    cost_status: v.costStatus ?? null,
    suggested_price: v.suggestedPrice ?? null,
    production_data: v.productionData ?? null,
  }
}

export class AdminProductService {
  constructor(
    private readonly products: ProductRepository,
    private readonly categories: CategoryRepository,
    private readonly catalogOptions: CatalogOptionRepository,
    private readonly subcategories: SubcategoryRepository,
  ) {}

  /** Índice id → nombre y categoría de todas las subcategorías (para etiquetas de producto). */
  private async subcategoryLabelIndex() {
    const subs = await this.subcategories.findAllDomain()
    return new Map(subs.map((s) => [s.id, { name: s.name, categoryId: s.categoryId }] as const))
  }

  private async categoryLabelIndex() {
    const cats = await this.categories.findAll()
    return new Map(cats.map((c) => [c.id, { name: c.name }] as const))
  }

  /**
   * Valida que la subcategoría exista y que su categoría también. Una subcategoría o categoría
   * inactiva solo se admite si el producto ya la tenía asignada (no bloquea ediciones de otros campos).
   */
  private async resolveAssignableSubcategory(
    subcategoryId: string,
    currentSubcategoryId?: string | null,
  ): Promise<{ subcategoryId: string; categorySlug: string }> {
    const keepsCurrent = currentSubcategoryId === subcategoryId
    const sub = await this.subcategories.findRawById(subcategoryId)
    if (!sub) throw AppError.badRequest('La subcategoría seleccionada no existe')
    if (!keepsCurrent && sub.status === 'inactive') {
      throw AppError.badRequest('La subcategoría seleccionada está inactiva')
    }
    const category = await this.categories.findById(String(sub.category_id))
    if (!category) throw AppError.badRequest('La categoría de la subcategoría no existe')
    if (!keepsCurrent && category.status === 'inactive') {
      throw AppError.badRequest('La categoría de la subcategoría está inactiva')
    }
    return { subcategoryId, categorySlug: category.slug }
  }

  async list(query: Record<string, unknown>) {
    const { page, limit, skip, search } = resolvePagingQuery(query, {
      defaultLimit: 20,
      maxLimit: 200,
    })
    const hierarchy = await resolveProductHierarchyFilter(
      this.categories,
      this.subcategories,
      typeof query.category === 'string' ? query.category : undefined,
      typeof query.subcategory === 'string' ? query.subcategory : undefined,
    )
    if (hierarchy.empty) {
      return { products: [], items: [], pagination: buildPaginationMeta(0, page, limit) }
    }
    const filter = { categorySlug: hierarchy.categorySlug, subcategoryId: hierarchy.subcategoryId }
    const [list, total, subMap, catMap] = await Promise.all([
      this.products.listAdmin(limit, skip, search || undefined, filter),
      this.products.countAllAdmin(search || undefined, filter),
      this.subcategoryLabelIndex(),
      this.categoryLabelIndex(),
    ])
    const serialized = list.map((p) => serializeProduct(p, labelsFor(p.subcategoryId, subMap, catMap)))
    return {
      products: serialized,
      items: serialized,
      pagination: buildPaginationMeta(total, page, limit),
    }
  }

  async get(idOrSlug: string) {
    const product = await this.products.findBySlugOrId(idOrSlug)
    if (!product) throw AppError.notFound('Producto no encontrado')
    const raw = await this.products.getProductRawByIdOrSlug(product.id)
    const axes = await this.catalogOptions.listAxesWithValuesByProductId(product.id)
    const legacy = axes.length
      ? []
      : await this.catalogOptions.listLegacyOptionsByProductSlug(product.slug)
    const variants = product.variants.map(serializeAdminVariant)
    const rawAny = raw as Record<string, unknown> | null
    const labels = labelsFor(
      product.subcategoryId,
      await this.subcategoryLabelIndex(),
      await this.categoryLabelIndex(),
    )
    return {
      product: {
        ...serializeProduct(product, labels),
        pdpShowSensoryBlock: rawAny?.pdpShowSensoryBlock === true,
        pdpSensoryNotes: Array.isArray(rawAny?.pdpSensoryNotes) ? rawAny.pdpSensoryNotes : [],
        pdpSensoryIntensity: (rawAny?.pdpSensoryIntensity as string | null | undefined) ?? null,
        pdpSensoryIdealFor: (rawAny?.pdpSensoryIdealFor as string | null | undefined) ?? null,
        pdpSensoryBurnHours: (rawAny?.pdpSensoryBurnHours as string | null | undefined) ?? null,
        pdpTrustBadgeIds: Array.isArray(rawAny?.pdpTrustBadgeIds) ? rawAny.pdpTrustBadgeIds : [],
        productionRecipeId:
          typeof rawAny?.productionRecipeId === 'string' ? rawAny.productionRecipeId : null,
      },
      variants,
      options: legacy.map((o, idx) => ({
        id: `legacy-${idx}`,
        name: o.name,
        values: o.values ?? [],
      })),
      optionsFormat: axes.length ? ('normalized' as const) : ('legacy' as const),
      optionAxes: axes.length ? axes : null,
    }
  }

  async create(data: {
    name: string
    slug: string
    description?: string
    subcategory_id: string
    brand?: string
    status?: 'active' | 'inactive'
    image_path?: string
    tax_rate?: number | null
  }) {
    const assigned = await this.resolveAssignableSubcategory(data.subcategory_id)
    try {
      const created = await this.products.createProduct({
        ...data,
        subcategory_id: assigned.subcategoryId,
        category_slug: assigned.categorySlug,
      })
      return { product: serializeProduct(created) }
    } catch (e: unknown) {
      if ((e as { code?: number }).code === 11000)
        throw AppError.conflict('Ya existe un producto con ese slug')
      throw e
    }
  }

  async update(
    id: string,
    patch: Partial<{
      name: string
      slug: string
      description?: string | null
      subcategory_id?: string
      brand?: string | null
      status: 'active' | 'inactive'
      image_path?: string | null
      tax_rate?: number | null
      option_axes?: Array<{
        id?: string
        name: string
        position?: number
        values: Array<
          | { id?: string; optionId?: string; value: string; slug?: string; position?: number }
          | string
        >
      }>
    }>,
  ) {
    const normalized: Parameters<ProductRepository['updateProduct']>[1] = {}
    if (patch.tax_rate !== undefined) normalized.tax_rate = patch.tax_rate
    if (patch.name !== undefined) normalized.name = patch.name
    if (patch.slug !== undefined) normalized.slug = patch.slug
    if (patch.description !== undefined) normalized.description = patch.description ?? undefined
    if (patch.subcategory_id !== undefined) {
      const current = await this.products.findBySlugOrId(id)
      if (!current) throw AppError.notFound('Producto no encontrado')
      const assigned = await this.resolveAssignableSubcategory(
        patch.subcategory_id,
        current.subcategoryId ?? null,
      )
      normalized.subcategory_id = assigned.subcategoryId
      normalized.category_slug = assigned.categorySlug
    }
    if (patch.brand !== undefined) normalized.brand = patch.brand ?? undefined
    if (patch.status !== undefined) normalized.status = patch.status
    if (patch.image_path !== undefined) normalized.image_path = patch.image_path ?? undefined

    try {
      const updated = await this.products.updateProduct(id, normalized)
      if (!updated) throw AppError.notFound('Producto no encontrado')

      // Actualizar ejes de opciones si se proporcionan
      if (patch.option_axes !== undefined) {
        const normalizedAxes = patch.option_axes.map((axis, idx) => ({
          name: axis.name,
          position: axis.position ?? idx,
          values: axis.values.map((val, vidx) => {
            const value = typeof val === 'string' ? val : val.value
            return {
              value,
              position: typeof val === 'string' ? vidx : (val.position ?? vidx),
              slug: typeof val === 'string' ? undefined : val.slug,
            }
          }),
        }))
        await this.catalogOptions.replaceCatalogForProduct(updated.id, normalizedAxes)
      }

      return { product: serializeProduct(updated) }
    } catch (e: unknown) {
      if ((e as { code?: number }).code === 11000)
        throw AppError.conflict('Ya existe un producto con ese slug')
      throw e
    }
  }

  async delete(id: string) {
    const ok = await this.products.deleteProduct(id)
    if (!ok) throw AppError.notFound('Producto no encontrado')
    return { ok: true }
  }

  async listVariants(productIdOrSlug: string) {
    const product = await this.products.findBySlugOrId(productIdOrSlug)
    if (!product) throw AppError.notFound('Producto no encontrado')
    const data = product.variants.map((v) => ({
      id: v.id ?? v.sku,
      sku: v.sku,
      barcode: v.barcode ?? null,
      price: v.price,
      currency: v.currency,
      options: v.options ?? {},
      stock: v.stock,
      productionRecipeId: v.productionRecipeId ?? null,
      production_recipe_id: v.productionRecipeId ?? null,
      compareAtPrice: v.compareAtPrice ?? null,
      imagePath: v.imagePath ?? null,
      reserved: v.reserved,
      available: v.available,
    }))
    // `data` es el contrato del admin LUMIA; `variants` queda por compatibilidad.
    return { data, variants: data }
  }

  async createVariant(
    productIdOrSlug: string,
    data: {
      sku: string
      barcode?: string
      price: number
      currency: string
      options?: Record<string, string>
      optionValueIds?: string[]
      optionRules?: Array<{ optionId: string; allowedValueIds?: string[] }>
      compare_at_price?: number
      image_path?: string
    },
  ) {
    const product = await this.products.findBySlugOrId(productIdOrSlug)
    if (!product) throw AppError.notFound('Producto no encontrado')

    // Validar optionValueIds si se proporcionan
    if (data.optionValueIds?.length) {
      const axes = await this.catalogOptions.listAxesWithValuesByProductId(product.id)
      const allValidIds = new Set<string>()
      for (const axis of axes) {
        for (const value of axis.values) {
          if (value.id) allValidIds.add(String(value.id))
        }
      }

      for (const id of data.optionValueIds) {
        if (!allValidIds.has(id)) {
          throw AppError.badRequest(`El valor de opción ${id} no existe para este producto`)
        }
      }
    }

    // Validar que no exista variante con las mismas opciones
    const newOptions = data.options ?? {}
    if (Object.keys(newOptions).length > 0) {
      const newOptionsStr = JSON.stringify(newOptions)
      for (const variant of product.variants) {
        const existingOptionsStr = JSON.stringify(variant.options ?? {})
        if (existingOptionsStr === newOptionsStr) {
          throw AppError.conflict('Ya existe una variante con exactamente las mismas opciones')
        }
      }
    }

    try {
      const v = await this.products.createVariant({
        product_slug: product.slug,
        sku: data.sku,
        barcode: data.barcode,
        price: data.price,
        currency: data.currency,
        options: data.options,
        option_value_ids: data.optionValueIds,
        option_rules: data.optionRules?.map((r) => ({
          option_id: r.optionId,
          allowed_value_ids: r.allowedValueIds,
        })),
        compare_at_price: data.compare_at_price,
        image_path: data.image_path,
      })
      return {
        variant: {
          sku: v.sku,
          barcode: v.barcode ?? null,
          price: v.price,
          currency: v.currency,
          options: v.options ?? {},
          compareAtPrice: v.compare_at_price ?? null,
          imagePath: v.image_path ?? null,
        },
      }
    } catch (e: unknown) {
      if ((e as Error).message === 'DUPLICATE_SKU')
        throw AppError.conflict('Ya existe una variante con ese SKU')
      if ((e as Error).message === 'DUPLICATE_BARCODE')
        throw AppError.conflict('Ya existe una variante con ese código de barras')
      throw e
    }
  }

  async updateVariant(
    productIdOrSlug: string,
    sku: string,
    patch: Partial<{
      barcode: string | null
      price: number
      currency: string
      options: Record<string, string>
      optionValueIds: string[]
      optionRules: Array<{ optionId: string; allowedValueIds?: string[] }>
      compare_at_price: number | null
      image_path: string | null
    }>,
  ) {
    const product = await this.products.findBySlugOrId(productIdOrSlug)
    if (!product) throw AppError.notFound('Producto no encontrado')
    const variant = await this.products.getVariantBySku(sku)
    if (!variant || variant.product_slug !== product.slug) {
      throw AppError.notFound('La variante no pertenece a este producto')
    }

    // Validar optionValueIds si se proporcionan
    if (patch.optionValueIds?.length) {
      const axes = await this.catalogOptions.listAxesWithValuesByProductId(product.id)
      const allValidIds = new Set<string>()
      for (const axis of axes) {
        for (const value of axis.values) {
          if (value.id) allValidIds.add(String(value.id))
        }
      }

      for (const id of patch.optionValueIds) {
        if (!allValidIds.has(id)) {
          throw AppError.badRequest(`El valor de opción ${id} no existe para este producto`)
        }
      }
    }

    const normalized: Parameters<ProductRepository['updateVariant']>[1] = {}
    if (patch.barcode !== undefined) {
      if (patch.barcode) {
        const owner = await this.products.findVariantByBarcode(patch.barcode)
        if (owner && owner.sku !== sku) {
          throw AppError.conflict('Ya existe una variante con ese código de barras')
        }
      }
      normalized.barcode = patch.barcode ?? null
    }
    if (patch.price !== undefined) normalized.price = patch.price
    if (patch.currency !== undefined) normalized.currency = patch.currency.trim().toUpperCase()

    // Validar opciones duplicadas si se están actualizando
    if (patch.options !== undefined) {
      const newOptionsStr = JSON.stringify(patch.options)
      for (const v of product.variants) {
        if (v.sku !== sku) {
          // No comparar consigo mismo
          const existingOptionsStr = JSON.stringify(v.options ?? {})
          if (existingOptionsStr === newOptionsStr) {
            throw AppError.conflict('Ya existe otra variante con exactamente las mismas opciones')
          }
        }
      }
      normalized.options = patch.options
    }

    if (patch.optionValueIds !== undefined) normalized.option_value_ids = patch.optionValueIds
    if (patch.optionRules !== undefined)
      normalized.option_rules = patch.optionRules?.map((r) => ({
        option_id: r.optionId,
        allowed_value_ids: r.allowedValueIds,
      }))
    if (patch.compare_at_price !== undefined)
      normalized.compare_at_price = patch.compare_at_price ?? undefined
    if (patch.image_path !== undefined) normalized.image_path = patch.image_path ?? undefined
    const updated = await this.products.updateVariant(sku, normalized)
    if (!updated) throw AppError.notFound('Variante no encontrada')
    return {
      variant: {
        sku: updated.sku,
        barcode: updated.barcode ?? null,
        price: updated.price,
        currency: updated.currency,
        options: updated.options ?? {},
        compareAtPrice: updated.compare_at_price ?? null,
        imagePath: updated.image_path ?? null,
      },
    }
  }

  async deleteVariant(productIdOrSlug: string, sku: string) {
    const product = await this.products.findBySlugOrId(productIdOrSlug)
    if (!product) throw AppError.notFound('Producto no encontrado')
    const variant = await this.products.getVariantBySku(sku)
    if (!variant || variant.product_slug !== product.slug) {
      throw AppError.notFound('La variante no pertenece a este producto')
    }
    const ok = await this.products.deleteVariant(sku)
    if (!ok) throw AppError.notFound('Variante no encontrada')
    return { ok: true }
  }

  async assertVariantBelongs(productIdOrSlug: string, sku: string): Promise<void> {
    const product = await this.products.findBySlugOrId(productIdOrSlug)
    if (!product) throw AppError.notFound('Producto no encontrado')
    const variant = await this.products.getVariantBySku(sku)
    if (!variant || variant.product_slug !== product.slug) {
      throw AppError.notFound('La variante no pertenece a este producto')
    }
  }

  async getOptions(productIdOrSlug: string) {
    const product = await this.products.findBySlugOrId(productIdOrSlug)
    if (!product) throw AppError.notFound('Producto no encontrado')
    const axes = await this.catalogOptions.listAxesWithValuesByProductId(product.id)
    const legacy = axes.length
      ? []
      : await this.catalogOptions.listLegacyOptionsByProductSlug(product.slug)
    return {
      optionsFormat: axes.length ? ('normalized' as const) : ('legacy' as const),
      optionAxes: axes.length ? axes : null,
      legacyOptions: legacy.length ? legacy : null,
    }
  }

  async putOptions(
    productIdOrSlug: string,
    axes: Array<{
      name: string
      position?: number
      values: Array<{ value: string; position?: number }>
    }>,
  ) {
    const product = await this.products.findBySlugOrId(productIdOrSlug)
    if (!product) throw AppError.notFound('Producto no encontrado')
    await this.catalogOptions.replaceCatalogForProduct(
      product.id,
      axes.map((ax, i) => ({
        name: ax.name,
        position: ax.position ?? i,
        values: ax.values.map((v, j) => ({ value: v.value, position: v.position ?? j })),
      })),
    )
    await this.catalogOptions.clearLegacyOptions(product.slug)
    return { ok: true, optionsFormat: 'normalized' as const }
  }

  async listPromotionProducts(query: Record<string, unknown>) {
    const { page, limit, skip, search } = resolvePagingQuery(query, {
      defaultLimit: 20,
      maxLimit: 100,
    })
    const first = (v: unknown) => {
      if (v == null) return undefined
      if (Array.isArray(v)) return first(v[0])
      const s = String(v).trim()
      return s || undefined
    }
    const includedRaw = query.includedCategorySlugs
    const includedParts: string[] = []
    if (Array.isArray(includedRaw)) includedRaw.forEach((x) => includedParts.push(String(x)))
    else if (includedRaw != null && String(includedRaw).trim())
      includedParts.push(String(includedRaw))
    const includedCategorySlugs = new Set(includedParts.map((s) => s.trim()).filter(Boolean))

    const stockRaw = first(query.stock) ?? 'all'
    const stock = (['in', 'out', 'all'].includes(stockRaw) ? stockRaw : 'all') as
      | 'in'
      | 'out'
      | 'all'
    const statusRaw = first(query.status)
    const status = statusRaw === 'active' || statusRaw === 'inactive' ? statusRaw : undefined
    const minPriceStr = first(query.minPrice)
    const maxPriceStr = first(query.maxPrice)
    const minPrice = minPriceStr != null ? Number(minPriceStr) : undefined
    const maxPrice = maxPriceStr != null ? Number(maxPriceStr) : undefined

    const { items, total } = await this.products.listPromotionPicker({
      skip,
      limit,
      search: search || undefined,
      category: first(query.category),
      brand: first(query.brand),
      status,
      stock,
      minPrice: minPrice != null && Number.isFinite(minPrice) ? minPrice : undefined,
      maxPrice: maxPrice != null && Number.isFinite(maxPrice) ? maxPrice : undefined,
      includedCategorySlugs,
    })
    return { items, pagination: buildPaginationMeta(total, page, limit) }
  }
}

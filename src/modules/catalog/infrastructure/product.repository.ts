import type { Db } from 'mongodb'
import { BaseRepository, getCollection } from '../../../database/repositories/base.repository.js'
import {
  toProductDomain,
  type ProductDomain,
  type ProductEntity,
  type ProductWithVariants,
  type VariantDomain,
  type VariantEntity,
  type InventoryItemEntity,
} from '../domain/catalog.entity.js'

export class ProductRepository extends BaseRepository<ProductEntity> {
  private readonly variants = getCollection<VariantEntity>(this.collection.db, 'variants')
  private readonly inventory = getCollection<InventoryItemEntity>(this.collection.db, 'inventory_items')

  constructor(db: Db) {
    super(getCollection(db, 'products'))
  }

  async ensureIndexes(): Promise<void> {
    await super.ensureIndexes([
      { key: { slug: 1 }, unique: true },
      { key: { category_slug: 1 } },
      { key: { status: 1 } },
      { key: { sales_total_units: -1 } },
    ])
  }

  private buildActiveFilter(search?: string, categorySlug?: string): Record<string, unknown> {
    const filter: Record<string, unknown> = {
      $or: [{ status: 'active' }, { status: { $exists: false } }],
    }
    if (categorySlug) {
      filter.category_slug = categorySlug
    }
    if (search) {
      filter.$and = [
        {
          $or: [
            { name: { $regex: search, $options: 'i' } },
            { slug: { $regex: search, $options: 'i' } },
            { description: { $regex: search, $options: 'i' } },
          ],
        },
      ]
    }
    return filter
  }

  async findActivePaged(
    limit: number,
    skip: number,
    search?: string,
    categorySlug?: string,
  ): Promise<ProductDomain[]> {
    const filter = this.buildActiveFilter(search, categorySlug)
    const docs = await this.findMany(filter as never, {
      skip,
      limit,
      sort: { created_at: -1 },
    })
    return docs.map(toProductDomain)
  }

  async countActive(search?: string, categorySlug?: string): Promise<number> {
    const filter = this.buildActiveFilter(search, categorySlug)
    return this.count(filter as never)
  }

  async findBySlugOrId(idOrSlug: string): Promise<ProductWithVariants | null> {
    const { ObjectId } = await import('mongodb')
    let doc = await this.findOne({ slug: idOrSlug } as never)
    if (!doc && ObjectId.isValid(idOrSlug)) {
      doc = await this.findOne({ _id: new ObjectId(idOrSlug) } as never)
    }
    if (!doc) return null

    const product = toProductDomain(doc)
    const variantDocs = await this.variants.find({ product_slug: product.slug }).toArray()
    const skus = variantDocs.map((v) => v.sku)
    const inventoryDocs =
      skus.length > 0
        ? await this.inventory.find({ sku: { $in: skus } }).toArray()
        : []
    const inventoryBySku = new Map(inventoryDocs.map((i) => [i.sku, i]))

    const variants: VariantDomain[] = variantDocs.map((v) => {
      const inv = inventoryBySku.get(v.sku)
      const quantity = inv?.quantity ?? 0
      const reserved = inv?.reserved ?? 0
      return {
        sku: v.sku,
        productSlug: v.product_slug,
        description: v.description,
        options: v.options ?? {},
        price: v.price,
        currency: v.currency ?? 'COP',
        compareAtPrice: v.compare_at_price,
        imagePath: v.image_path,
        stock: quantity,
        reserved,
        available: Math.max(0, quantity - reserved),
      }
    })

    const fromPrice =
      variants.length > 0 ? Math.min(...variants.map((v) => v.price)) : undefined

    return { ...product, variants, fromPrice }
  }

  async findTopSellingSlugs(topN: number): Promise<string[]> {
    const docs = await this.findMany(
      {
        sales_total_units: { $gt: 0 },
        $or: [{ status: 'active' }, { status: { $exists: false } }],
      } as never,
      { limit: topN, sort: { sales_total_units: -1 } },
    )
    return docs.map((d) => d.slug)
  }

  private buildAdminSearchFilter(search?: string): Record<string, unknown> {
    if (!search?.trim()) return {}
    const term = search.trim()
    return {
      $or: [
        { name: { $regex: term, $options: 'i' } },
        { slug: { $regex: term, $options: 'i' } },
        { description: { $regex: term, $options: 'i' } },
      ],
    }
  }

  async listAdmin(limit: number, skip: number, search?: string): Promise<ProductDomain[]> {
    const docs = await this.findMany(this.buildAdminSearchFilter(search) as never, {
      skip,
      limit,
      sort: { created_at: -1 },
    })
    return docs.map(toProductDomain)
  }

  async countAllAdmin(search?: string): Promise<number> {
    return this.count(this.buildAdminSearchFilter(search) as never)
  }

  async countActiveAdmin(): Promise<number> {
    return this.count({ status: { $ne: 'inactive' } } as never)
  }

  async createProduct(data: {
    name: string
    slug: string
    description?: string
    category_slug?: string
    brand?: string
    status?: 'active' | 'inactive'
    image_path?: string
  }): Promise<ProductDomain> {
    const now = new Date()
    const id = await this.insertOne({
      name: data.name,
      slug: data.slug,
      description: data.description,
      category_slug: data.category_slug,
      brand: data.brand,
      status: data.status ?? 'active',
      image_path: data.image_path,
      created_at: now,
      updated_at: now,
    } as never)
    const doc = await this.findById(id)
    if (!doc) throw new Error('Failed to create product')
    return toProductDomain(doc)
  }

  async updateProduct(
    idOrSlug: string,
    patch: Partial<{
      name: string
      slug: string
      description?: string
      category_slug?: string
      brand?: string
      status: 'active' | 'inactive'
      image_path?: string
    }>,
  ): Promise<ProductDomain | null> {
    const { ObjectId } = await import('mongodb')
    let filter: Record<string, unknown> = { slug: idOrSlug }
    if (ObjectId.isValid(idOrSlug)) filter = { _id: new ObjectId(idOrSlug) }
    const set = { ...patch, updated_at: new Date() }
    const res = await this.collection.updateOne(filter as never, { $set: set })
    if (!res.matchedCount) return null
    const doc = await this.findOne(filter as never)
    return doc ? toProductDomain(doc) : null
  }

  async deleteProduct(idOrSlug: string): Promise<boolean> {
    const { ObjectId } = await import('mongodb')
    if (ObjectId.isValid(idOrSlug)) return this.deleteById(idOrSlug)
    const res = await this.collection.deleteOne({ slug: idOrSlug } as never)
    return res.deletedCount > 0
  }

  async findTopSelling(limit: number) {
    return this.collection
      .find({ status: { $ne: 'inactive' } })
      .sort({ sales_total_units: -1 })
      .limit(limit)
      .project({ slug: 1, name: 1, image_path: 1, category_slug: 1, sales_total_units: 1, popularity_score: 1 })
      .toArray()
  }

  async findNamesBySlugs(slugs: string[]): Promise<Map<string, string>> {
    if (!slugs.length) return new Map()
    const prods = await this.collection.find({ slug: { $in: slugs } }).project({ slug: 1, name: 1 }).toArray()
    return new Map(prods.map((p) => [p.slug, p.name]))
  }

  async findTopPopular(limit: number) {
    return this.collection
      .find({ status: { $ne: 'inactive' } })
      .sort({ popularity_score: -1 })
      .limit(limit)
      .project({ slug: 1, name: 1, image_path: 1, category_slug: 1, sales_total_units: 1, popularity_score: 1 })
      .toArray()
  }

  async findOutOfStock(limit: number) {
    return this.collection
      .aggregate([
        { $match: { status: { $ne: 'inactive' } } },
        { $lookup: { from: 'variants', localField: 'slug', foreignField: 'product_slug', as: 'variants' } },
        { $unwind: { path: '$variants', preserveNullAndEmptyArrays: true } },
        { $lookup: { from: 'inventory_items', localField: 'variants.sku', foreignField: 'sku', as: 'inv' } },
        {
          $addFields: {
            variantAvailable: {
              $subtract: [{ $sum: '$inv.quantity' }, { $sum: '$inv.reserved' }],
            },
          },
        },
        { $group: { _id: '$slug', name: { $first: '$name' }, image_path: { $first: '$image_path' }, category_slug: { $first: '$category_slug' }, available: { $sum: '$variantAvailable' } } },
        { $match: { available: { $lte: 0 } } },
        { $sort: { available: 1 } },
        { $limit: limit },
      ])
      .toArray()
  }

  async findEmptyCategories(limit: number) {
    return this.collection.db
      .collection('categories')
      .aggregate([
        { $lookup: { from: 'products', localField: 'slug', foreignField: 'category_slug', as: 'products' } },
        { $addFields: { productCount: { $size: '$products' } } },
        { $match: { productCount: 0 } },
        { $sort: { name: 1 } },
        { $limit: limit },
        { $project: { products: 0 } },
      ])
      .toArray()
  }

  async enrichFavoriteSlugs(rows: Array<{ slug: string; favorites: number }>) {
    if (!rows.length) return []
    const slugs = rows.map((r) => r.slug)
    const prods = await this.collection
      .find({ slug: { $in: slugs } })
      .project({ slug: 1, name: 1, image_path: 1, category_slug: 1, sales_total_units: 1, popularity_score: 1 })
      .toArray()
    const map = new Map(prods.map((p) => [p.slug, p]))
    return rows.map((r) => ({ slug: r.slug, favorites: r.favorites, ...map.get(r.slug) }))
  }

  async listVariantsByProductSlug(productSlug: string): Promise<VariantEntity[]> {
    return this.variants.find({ product_slug: productSlug }).sort({ sku: 1 }).toArray()
  }

  async getVariantBySku(sku: string): Promise<VariantEntity | null> {
    return this.variants.findOne({ sku })
  }

  async createVariant(data: {
    product_slug: string
    sku: string
    price: number
    currency: string
    options?: Record<string, string>
    compare_at_price?: number
    image_path?: string
    description?: string
  }): Promise<VariantEntity> {
    const existing = await this.variants.findOne({ sku: data.sku })
    if (existing) {
      const err = new Error('DUPLICATE_SKU')
      ;(err as Error & { code?: string }).code = 'DUPLICATE_SKU'
      throw err
    }
    const now = new Date()
    const doc: VariantEntity = {
      product_slug: data.product_slug,
      sku: data.sku.trim(),
      price: data.price,
      currency: data.currency.trim().toUpperCase(),
      options: data.options ?? {},
      compare_at_price: data.compare_at_price,
      image_path: data.image_path,
      description: data.description,
      created_at: now,
    }
    await this.variants.insertOne(doc as never)
    return doc
  }

  async updateVariant(
    sku: string,
    patch: Partial<Pick<VariantEntity, 'price' | 'currency' | 'options' | 'compare_at_price' | 'image_path' | 'description'>>,
  ): Promise<VariantEntity | null> {
    const res = await this.variants.updateOne({ sku }, { $set: patch })
    if (!res.matchedCount) return null
    return this.variants.findOne({ sku })
  }

  async deleteVariant(sku: string): Promise<boolean> {
    const res = await this.variants.deleteOne({ sku })
    if (res.deletedCount > 0) {
      await this.inventory.deleteOne({ sku })
      return true
    }
    return false
  }

  async getProductRawByIdOrSlug(idOrSlug: string): Promise<(ProductEntity & { productionRecipeId?: string; production?: Record<string, unknown> }) | null> {
    const { ObjectId } = await import('mongodb')
    let filter: Record<string, unknown> = { slug: idOrSlug }
    if (ObjectId.isValid(idOrSlug)) filter = { _id: new ObjectId(idOrSlug) }
    return this.collection.findOne(filter as never) as Promise<(ProductEntity & { productionRecipeId?: string; production?: Record<string, unknown> }) | null>
  }

  async assignProductionRecipe(idOrSlug: string, recipeId: string): Promise<boolean> {
    const { ObjectId } = await import('mongodb')
    let filter: Record<string, unknown> = { slug: idOrSlug }
    if (ObjectId.isValid(idOrSlug)) filter = { _id: new ObjectId(idOrSlug) }
    const res = await this.collection.updateOne(filter as never, {
      $set: { productionRecipeId: recipeId, updated_at: new Date() },
    })
    return res.matchedCount > 0
  }

  async unassignProductionRecipe(idOrSlug: string): Promise<boolean> {
    const { ObjectId } = await import('mongodb')
    let filter: Record<string, unknown> = { slug: idOrSlug }
    if (ObjectId.isValid(idOrSlug)) filter = { _id: new ObjectId(idOrSlug) }
    const res = await this.collection.updateOne(filter as never, {
      $unset: { productionRecipeId: '' },
      $set: { updated_at: new Date() },
    })
    return res.matchedCount > 0
  }

  async updateVariantRecipe(productSlug: string, sku: string, recipeId: string | null): Promise<boolean> {
    const { ObjectId } = await import('mongodb')
    const update =
      recipeId && ObjectId.isValid(recipeId)
        ? { $set: { production_recipe_id: new ObjectId(recipeId) } }
        : { $set: { production_recipe_id: null } }
    const res = await this.variants.updateOne({ product_slug: productSlug, sku }, update as never)
    return res.matchedCount > 0
  }

  async getVariantRaw(productSlug: string, sku: string): Promise<VariantEntity | null> {
    return this.variants.findOne({ product_slug: productSlug, sku })
  }

  async updateProductProduction(idOrSlug: string, production: Record<string, unknown>): Promise<boolean> {
    const { ObjectId } = await import('mongodb')
    let filter: Record<string, unknown> = { slug: idOrSlug }
    if (ObjectId.isValid(idOrSlug)) filter = { _id: new ObjectId(idOrSlug) }
    const set: Record<string, unknown> = { updated_at: new Date() }
    for (const [k, v] of Object.entries(production)) {
      set[`production.${k}`] = v
    }
    const res = await this.collection.updateOne(filter as never, { $set: set })
    return res.matchedCount > 0
  }

  async updateVariantProductionData(
    productSlug: string,
    sku: string,
    data: Record<string, unknown>,
  ): Promise<boolean> {
    const set: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(data)) {
      set[`production_data.${k}`] = v
    }
    const res = await this.variants.updateOne({ product_slug: productSlug, sku }, { $set: set })
    return res.matchedCount > 0
  }

  async insertCostSnapshot(doc: Record<string, unknown>): Promise<string> {
    const col = this.collection.db.collection('variant_cost_snapshots')
    const result = await col.insertOne({ ...doc, calculated_at: new Date() })
    return result.insertedId.toString()
  }

  async listCostSnapshots(productId: string, variantSku: string, limit = 50) {
    const { ObjectId } = await import('mongodb')
    const col = this.collection.db.collection('variant_cost_snapshots')
    return col
      .find({ product_id: new ObjectId(productId), variant_sku: variantSku })
      .sort({ calculated_at: -1 })
      .limit(limit)
      .toArray()
  }

  async getLatestSnapshotsByProduct(productId: string) {
    const { ObjectId } = await import('mongodb')
    const col = this.collection.db.collection('variant_cost_snapshots')
    return col
      .aggregate([
        { $match: { product_id: new ObjectId(productId) } },
        { $sort: { calculated_at: -1 } },
        {
          $group: {
            _id: '$variant_sku',
            suggested_price: { $first: '$suggested_price' },
            margin_percentage: { $first: '$margin_percentage' },
            calculated_at: { $first: '$calculated_at' },
          },
        },
      ])
      .toArray()
  }

  async listPromotionPicker(params: {
    skip: number
    limit: number
    search?: string
    category?: string
    brand?: string
    status?: 'active' | 'inactive'
    stock?: 'in' | 'out' | 'all'
    minPrice?: number
    maxPrice?: number
    includedCategorySlugs: Set<string>
  }) {
    const productMatch: Record<string, unknown> = {}
    if (params.search?.trim()) {
      const s = params.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      productMatch.$or = [{ name: { $regex: s, $options: 'i' } }, { slug: { $regex: s, $options: 'i' } }]
    }
    if (params.category) productMatch.category_slug = params.category
    if (params.brand) productMatch.brand = params.brand
    if (params.status) productMatch.status = params.status

    const rows = await this.collection
      .aggregate([
        { $match: productMatch },
        {
          $lookup: {
            from: 'variants',
            let: { productSlug: '$slug' },
            pipeline: [
              { $match: { $expr: { $eq: ['$product_slug', '$$productSlug'] } } },
              { $sort: { price: 1 } },
              { $limit: 1 },
              { $project: { sku: 1, price: 1 } },
            ],
            as: 'firstVariant',
          },
        },
        {
          $lookup: {
            from: 'variants',
            let: { productSlug: '$slug' },
            pipeline: [{ $match: { $expr: { $eq: ['$product_slug', '$$productSlug'] } } }, { $project: { sku: 1 } }],
            as: 'variantSkus',
          },
        },
        {
          $lookup: {
            from: 'inventory_items',
            let: { skus: '$variantSkus.sku' },
            pipeline: [
              { $match: { $expr: { $in: ['$sku', '$$skus'] } } },
              { $project: { quantity: 1, reserved: 1 } },
            ],
            as: 'inventoryRows',
          },
        },
        {
          $addFields: {
            minVariant: { $arrayElemAt: ['$firstVariant', 0] },
            availableStock: {
              $sum: {
                $map: {
                  input: '$inventoryRows',
                  as: 'inv',
                  in: { $max: [0, { $subtract: ['$$inv.quantity', { $ifNull: ['$$inv.reserved', 0] }] }] },
                },
              },
            },
          },
        },
        {
          $project: {
            _id: 1,
            slug: 1,
            name: 1,
            brand: 1,
            status: 1,
            category_slug: 1,
            image_path: 1,
            sku: '$minVariant.sku',
            basePrice: '$minVariant.price',
            availableStock: 1,
          },
        },
      ])
      .toArray()

    const filtered = rows.filter((r) => {
      const st = Number((r as { availableStock?: number }).availableStock ?? 0)
      const price = Number((r as { basePrice?: number }).basePrice ?? 0)
      if (params.stock === 'in' && st <= 0) return false
      if (params.stock === 'out' && st > 0) return false
      if (params.minPrice != null && Number.isFinite(params.minPrice) && price < params.minPrice) return false
      if (params.maxPrice != null && Number.isFinite(params.maxPrice) && price > params.maxPrice) return false
      return true
    })

    const total = filtered.length
    const pageRows = filtered.slice(params.skip, params.skip + params.limit)
    const items = pageRows.map((r) => {
      const row = r as {
        _id: unknown
        slug: string
        name: string
        brand?: string
        status?: string
        category_slug?: string
        image_path?: string
        sku?: string
        basePrice?: number
        availableStock?: number
      }
      const categorySlug = row.category_slug ? String(row.category_slug) : null
      return {
        id: String(row._id),
        slug: String(row.slug),
        name: String(row.name),
        brand: row.brand ? String(row.brand) : null,
        status: row.status ? String(row.status) : 'active',
        categorySlug,
        imagePath: row.image_path ? String(row.image_path) : null,
        sku: row.sku ? String(row.sku) : null,
        basePrice: typeof row.basePrice === 'number' ? row.basePrice : null,
        stock: Number(row.availableStock ?? 0),
        alreadyIncludedByCategory: categorySlug ? params.includedCategorySlugs.has(categorySlug) : false,
      }
    })

    return { items, total }
  }

  async listForProduction(options: { search?: string; limit: number; skip: number }) {
    const filter: Record<string, unknown> = {}
    if (options.search?.trim()) {
      const s = options.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      filter.$or = [{ name: { $regex: s, $options: 'i' } }, { slug: { $regex: s, $options: 'i' } }]
    }

    const [products, total] = await Promise.all([
      this.collection
        .find(filter, {
          projection: { _id: 1, name: 1, slug: 1, status: 1, image_path: 1, productionRecipeId: 1 },
        })
        .sort({ name: 1 })
        .skip(options.skip)
        .limit(options.limit)
        .toArray(),
      this.collection.countDocuments(filter),
    ])

    const productSlugs = products.map((p) => p.slug).filter(Boolean) as string[]
    const variantCounts: Record<string, number> = {}
    const variantRecipeMap: Record<string, Set<string>> = {}

    if (productSlugs.length > 0) {
      const variants = await this.variants
        .find(
          { product_slug: { $in: productSlugs } },
          { projection: { product_slug: 1, production_recipe_id: 1 } },
        )
        .toArray()

      for (const v of variants) {
        const slug = v.product_slug
        variantCounts[slug] = (variantCounts[slug] ?? 0) + 1
        if (v.production_recipe_id) {
          if (!variantRecipeMap[slug]) variantRecipeMap[slug] = new Set()
          variantRecipeMap[slug].add(String(v.production_recipe_id))
        }
      }
    }

    const data = products.map((p) => {
      const pid = String(p._id)
      const slug = String(p.slug ?? '')
      const recipeId = (p as unknown as { productionRecipeId?: unknown }).productionRecipeId
        ? String((p as unknown as { productionRecipeId: unknown }).productionRecipeId)
        : null
      const variantRecipeCount = variantRecipeMap[slug]?.size ?? 0

      return {
        id: pid,
        name: String(p.name),
        slug,
        status: String((p as { status?: string }).status ?? 'active'),
        imagePath: (p as { image_path?: string }).image_path ?? null,
        variantCount: variantCounts[slug] ?? 0,
        hasRecipe: !!(recipeId || variantRecipeCount > 0),
        hasProductRecipe: !!recipeId,
        variantRecipeCount,
        productionRecipeId: recipeId,
      }
    })

    return { data, total }
  }

  async findAssociatedWithRecipe(recipeId: string) {
    const { ObjectId } = await import('mongodb')
    const oid = ObjectId.isValid(recipeId) ? new ObjectId(recipeId) : recipeId

    const [products, variants] = await Promise.all([
      this.collection
        .find({
          $or: [{ productionRecipeId: recipeId }, { productionRecipeId: oid }],
        } as never)
        .project({ _id: 1, name: 1, slug: 1 })
        .toArray(),
      this.variants
        .find({
          $or: [{ production_recipe_id: recipeId }, { production_recipe_id: oid }],
        } as never)
        .project({ _id: 1, product_slug: 1, sku: 1 })
        .toArray(),
    ])

    return {
      products: products.map((p) => ({
        id: String(p._id),
        name: String(p.name),
        slug: String(p.slug),
        type: 'product' as const,
      })),
      variants: variants.map((v) => ({
        id: String(v._id),
        productSlug: String(v.product_slug),
        sku: String(v.sku),
        type: 'variant' as const,
      })),
      totalAssociated: products.length + variants.length,
    }
  }

  async updateVariantPrice(sku: string, price: number): Promise<boolean> {
    const result = await this.variants.updateOne(
      { sku } as never,
      { $set: { price, updated_at: new Date() } },
    )
    return result.matchedCount > 0
  }
}

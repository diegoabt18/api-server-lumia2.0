import { getEnv } from '../../../config/env.js'
import { buildPaginationMeta, resolvePagingQuery } from '../../../common/utils/pagination.js'
import type { ProductRepository } from '../infrastructure/product.repository.js'
import type { PromotionRepository } from '../infrastructure/promotion.repository.js'
import {
  applyPromotionToVariants,
  resolveBestPromotionForProductFromEntities,
} from '../../pricing/promotion.service.js'

export class ProductService {
  constructor(
    private readonly products: ProductRepository,
    private readonly promotions: PromotionRepository,
  ) {}

  private async mapProductWithPromotions(
    p: Awaited<ReturnType<ProductRepository['findActivePaged']>>[number],
    full: Awaited<ReturnType<ProductRepository['findBySlugOrId']>>,
    promos: Awaited<ReturnType<PromotionRepository['findActiveAt']>>,
    topSet: Set<string>,
    popularMin: number,
  ) {
    const now = new Date()
    const resolved = resolveBestPromotionForProductFromEntities(
      p.slug,
      p.categorySlug ?? full?.categorySlug ?? null,
      promos,
      now,
    )
    const variants = applyPromotionToVariants(full?.variants ?? [], resolved)
    const fromPrice =
      variants.length > 0
        ? Math.min(...variants.map((x) => x.salePrice ?? x.price ?? 0))
        : full?.fromPrice

    const units = p.salesTotalUnits ?? 0
    let salesBadge: 'bestseller' | 'popular' | null = null
    if (topSet.has(p.slug)) salesBadge = 'bestseller'
    else if (units >= popularMin) salesBadge = 'popular'

    return {
      ...p,
      variants,
      fromPrice,
      salesBadge,
      stock: undefined,
    }
  }

  async list(query: Record<string, unknown>) {
    const env = getEnv()
    const { page, limit, skip, search } = resolvePagingQuery(query, {
      defaultLimit: 20,
      maxLimit: 100,
    })
    const categoryRaw = typeof query.category === 'string' ? query.category.trim() : ''
    const categorySlug = categoryRaw.split(',')[0]?.trim() || undefined

    const now = new Date()
    const [items, total, topSlugs, promos] = await Promise.all([
      this.products.findActivePaged(limit, skip, search || undefined, categorySlug),
      this.products.countActive(search || undefined, categorySlug),
      this.products.findTopSellingSlugs(env.STORE_BESTSELLER_TOP_N),
      this.promotions.findActiveAt(now),
    ])

    const topSet = new Set(topSlugs)
    const popularMin = env.STORE_POPULAR_MIN_UNITS

    const mapped = await Promise.all(
      items.map(async (p) => {
        const full = await this.products.findBySlugOrId(p.slug)
        return this.mapProductWithPromotions(p, full, promos, topSet, popularMin)
      }),
    )

    return {
      products: mapped,
      items: mapped,
      pagination: buildPaginationMeta(total, page, limit),
    }
  }

  async getById(idOrSlug: string) {
    const product = await this.products.findBySlugOrId(idOrSlug)
    if (!product) return null

    const promos = await this.promotions.findActiveAt(new Date())
    const resolved = resolveBestPromotionForProductFromEntities(
      product.slug,
      product.categorySlug ?? null,
      promos,
      new Date(),
    )
    const variants = applyPromotionToVariants(product.variants ?? [], resolved)
    const fromPrice =
      variants.length > 0
        ? Math.min(...variants.map((x) => x.salePrice ?? x.price ?? 0))
        : product.fromPrice

    return { ...product, variants, fromPrice }
  }
}

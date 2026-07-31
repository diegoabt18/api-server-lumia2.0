import { buildPaginationMeta, resolvePagingQuery } from '../../../common/utils/pagination.js'
import type { CategoryRepository } from '../infrastructure/category.repository.js'

export class CategoryService {
  constructor(private readonly categories: CategoryRepository) {}

  private serialize(
    c: { id: string; name: string; slug: string; createdAt: string },
    productCount: number,
  ) {
    return {
      id: c.id,
      name: c.name,
      slug: c.slug,
      createdAt: c.createdAt,
      productCount,
    }
  }

  async list(query: Record<string, unknown>) {
    const countMap = await this.categories.productCountByCategorySlug()

    const noPagingParams =
      query.page == null &&
      query.limit == null &&
      (query.search == null || String(query.search).trim() === '')

    if (noPagingParams) {
      const categories = await this.categories.findAll()
      const mapped = categories.map((c) =>
        this.serialize(c, countMap.get(c.slug) ?? 0),
      )
      const n = mapped.length
      return {
        categories: mapped,
        items: mapped,
        pagination: buildPaginationMeta(n, 1, Math.max(n, 1)),
      }
    }

    const { page, limit, skip, search } = resolvePagingQuery(query, {
      defaultLimit: 50,
      maxLimit: 200,
    })

    const [slice, total] = await Promise.all([
      this.categories.findPaged(skip, limit, search || undefined),
      this.categories.countAll(search || undefined),
    ])

    const mapped = slice.map((c) => this.serialize(c, countMap.get(c.slug) ?? 0))
    return {
      categories: mapped,
      items: mapped,
      pagination: buildPaginationMeta(total, page, limit),
    }
  }

  async getById(idOrSlug: string) {
    const category = await this.categories.findBySlugOrId(idOrSlug)
    if (!category) return null
    const countMap = await this.categories.productCountByCategorySlug()
    return this.serialize(category, countMap.get(category.slug) ?? 0)
  }
}

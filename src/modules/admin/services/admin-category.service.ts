import { AppError } from '../../../common/errors/app.error.js'
import { buildPaginationMeta, resolvePagingQuery } from '../../../common/utils/pagination.js'
import type { CategoryRepository } from '../../catalog/infrastructure/category.repository.js'

export class AdminCategoryService {
  constructor(private readonly categories: CategoryRepository) {}

  async list(query: Record<string, unknown>) {
    const { page, limit, skip, search } = resolvePagingQuery(query, { defaultLimit: 50, maxLimit: 200 })
    const [items, total, productCounts] = await Promise.all([
      this.categories.findPaged(skip, limit, search || undefined),
      this.categories.countAll(search || undefined),
      this.categories.productCountByCategorySlug(),
    ])
    const categories = items.map((c) => ({
      ...c,
      productCount: productCounts.get(c.slug) ?? 0,
    }))
    return { categories, items: categories, pagination: buildPaginationMeta(total, page, limit) }
  }

  async create(name: string, slug: string) {
    try {
      const category = await this.categories.createCategory(name, slug)
      return { category }
    } catch (e: unknown) {
      if ((e as { code?: number }).code === 11000) throw AppError.conflict('Ya existe una categoría con ese slug')
      throw e
    }
  }

  async update(id: string, patch: { name?: string; slug?: string }) {
    try {
      const updated = await this.categories.updateCategory(id, patch)
      if (!updated) throw AppError.notFound('Categoría no encontrada')
      return { category: updated }
    } catch (e: unknown) {
      if ((e as { code?: number }).code === 11000) throw AppError.conflict('Ya existe una categoría con ese slug')
      throw e
    }
  }

  async delete(id: string) {
    const ok = await this.categories.deleteCategory(id)
    if (!ok) throw AppError.notFound('Categoría no encontrada')
    return { ok: true }
  }
}

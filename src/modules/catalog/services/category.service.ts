import { buildPaginationMeta, resolvePagingQuery } from '../../../common/utils/pagination.js'
import type { CategoryDomain, SubcategoryDomain } from '../domain/catalog.entity.js'
import type { CategoryRepository } from '../infrastructure/category.repository.js'
import type { SubcategoryRepository } from '../infrastructure/subcategory.repository.js'

/**
 * Catálogo público: solo registros activos. Los contadores cuentan productos
 * (campo derivado category_slug / subcategory_id) y subcategorías activas.
 */
export class CategoryService {
  constructor(
    private readonly categories: CategoryRepository,
    private readonly subcategories: SubcategoryRepository,
  ) {}

  private serialize(
    c: CategoryDomain,
    counts: { products: number; subcategories: number },
  ) {
    return {
      id: c.id,
      name: c.name,
      slug: c.slug,
      description: c.description,
      imagePath: c.imagePath,
      sortOrder: c.sortOrder,
      createdAt: c.createdAt,
      productCount: counts.products,
      subcategoryCount: counts.subcategories,
    }
  }

  private serializeSub(s: SubcategoryDomain, productCount: number) {
    return {
      id: s.id,
      categoryId: s.categoryId,
      name: s.name,
      slug: s.slug,
      description: s.description,
      imagePath: s.imagePath,
      sortOrder: s.sortOrder,
      productCount,
    }
  }

  /**
   * Productos por categoría = suma de sus subcategorías activas (lo que el cliente ve en la tienda).
   * Los productos sin subcategoría no cuentan para la categoría.
   */
  private async productCountsByCategory(): Promise<Map<string, number>> {
    const [subs, subProductCounts] = await Promise.all([
      this.subcategories.findAllDomain(),
      this.subcategories.productCountsBySubcategoryId(),
    ])
    const map = new Map<string, number>()
    for (const s of subs) {
      if (s.status !== 'active') continue
      map.set(s.categoryId, (map.get(s.categoryId) ?? 0) + (subProductCounts.get(s.id) ?? 0))
    }
    return map
  }

  async list(query: Record<string, unknown>) {
    const [productCounts, subCounts] = await Promise.all([
      this.productCountsByCategory(),
      this.categories.subcategoryCountsByCategoryId(),
    ])

    const noPagingParams =
      query.page == null &&
      query.limit == null &&
      (query.search == null || String(query.search).trim() === '')

    if (noPagingParams) {
      const categories = await this.categories.findAll({ onlyActive: true })
      const mapped = categories.map((c) =>
        this.serialize(c, {
          products: productCounts.get(c.id) ?? 0,
          subcategories: subCounts.get(c.id)?.active ?? 0,
        }),
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
      this.categories.findPaged(skip, limit, search || undefined, { onlyActive: true }),
      this.categories.countAll(search || undefined, { onlyActive: true }),
    ])
    const mapped = slice.map((c) =>
        this.serialize(c, {
          products: productCounts.get(c.id) ?? 0,
          subcategories: subCounts.get(c.id)?.active ?? 0,
        }),
      )
    return {
      categories: mapped,
      items: mapped,
      pagination: buildPaginationMeta(total, page, limit),
    }
  }

  /** Categoría activa con sus subcategorías activas. null si no existe o está inactiva. */
  async getById(idOrSlug: string) {
    const category = await this.categories.findBySlugOrId(idOrSlug)
    if (!category || category.status !== 'active') return null
    const [productCounts, subs, subProductCounts] = await Promise.all([
      this.productCountsByCategory(),
      this.subcategories.findByCategory(category.id, { onlyActive: true }),
      this.subcategories.productCountsBySubcategoryId(),
    ])
    return {
      ...this.serialize(category, {
        products: productCounts.get(category.id) ?? 0,
        subcategories: subs.length,
      }),
      subcategories: subs.map((s) => this.serializeSub(s, subProductCounts.get(s.id) ?? 0)),
    }
  }

  /** Subcategorías activas de una categoría activa. null si la categoría no es visible. */
  async listSubcategories(categoryIdOrSlug: string) {
    const category = await this.categories.findBySlugOrId(categoryIdOrSlug)
    if (!category || category.status !== 'active') return null
    const [subs, subProductCounts] = await Promise.all([
      this.subcategories.findByCategory(category.id, { onlyActive: true }),
      this.subcategories.productCountsBySubcategoryId(),
    ])
    const mapped = subs.map((s) => this.serializeSub(s, subProductCounts.get(s.id) ?? 0))
    return { category: { id: category.id, name: category.name, slug: category.slug }, subcategories: mapped, items: mapped }
  }
}

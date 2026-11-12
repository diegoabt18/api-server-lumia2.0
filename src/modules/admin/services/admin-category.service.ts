import { AppError } from '../../../common/errors/app.error.js'
import { buildPaginationMeta, resolvePagingQuery } from '../../../common/utils/pagination.js'
import type { CatalogStatus, CategoryDomain, SubcategoryDomain } from '../../catalog/domain/catalog.entity.js'
import type { CategoryRepository, CategoryWritePatch } from '../../catalog/infrastructure/category.repository.js'
import type {
  SubcategoryRepository,
  SubcategoryWritePatch,
} from '../../catalog/infrastructure/subcategory.repository.js'

type CategoryInput = {
  name: string
  slug: string
  description?: string | null
  image_path?: string | null
  status?: CatalogStatus
  sort_order?: number
}

const DUPLICATE_CATEGORY_NAME = 'Ya existe una categoría con ese nombre'
const DUPLICATE_CATEGORY_SLUG = 'Ya existe una categoría con ese slug'
const DUPLICATE_SUBCATEGORY_NAME = 'Ya existe una subcategoría con ese nombre en esta categoría'
const DUPLICATE_SUBCATEGORY_SLUG = 'Ya existe una subcategoría con ese slug en esta categoría'

function isDuplicateKey(e: unknown): boolean {
  return (e as { code?: number }).code === 11000
}

function serializeCategory(c: CategoryDomain, counts: { subcategories: number; activeSubcategories: number; products: number }) {
  return {
    id: c.id,
    name: c.name,
    slug: c.slug,
    description: c.description,
    imagePath: c.imagePath,
    status: c.status,
    sortOrder: c.sortOrder,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    subcategoryCount: counts.subcategories,
    activeSubcategoryCount: counts.activeSubcategories,
    productCount: counts.products,
  }
}

function serializeSubcategory(s: SubcategoryDomain, productCount: number) {
  return {
    id: s.id,
    categoryId: s.categoryId,
    name: s.name,
    slug: s.slug,
    description: s.description,
    imagePath: s.imagePath,
    status: s.status,
    sortOrder: s.sortOrder,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    productCount,
  }
}

export class AdminCategoryService {
  constructor(
    private readonly categories: CategoryRepository,
    private readonly subcategories: SubcategoryRepository,
  ) {}

  async list(query: Record<string, unknown>) {
    const { page, limit, skip, search } = resolvePagingQuery(query, {
      defaultLimit: 50,
      maxLimit: 200,
    })
    const [items, total, productCounts, subCounts] = await Promise.all([
      this.categories.findPaged(skip, limit, search || undefined),
      this.categories.countAll(search || undefined),
      this.categories.productCountByCategorySlug(),
      this.categories.subcategoryCountsByCategoryId(),
    ])
    const categories = items.map((c) => {
      const sub = subCounts.get(c.id) ?? { total: 0, active: 0 }
      return serializeCategory(c, {
        subcategories: sub.total,
        activeSubcategories: sub.active,
        products: productCounts.get(c.slug) ?? 0,
      })
    })
    return { categories, items: categories, pagination: buildPaginationMeta(total, page, limit) }
  }

  async getById(idOrSlug: string) {
    const category = await this.categories.findBySlugOrId(idOrSlug)
    if (!category) throw AppError.notFound('Categoría no encontrada')
    const [productCounts, subCounts, subs, subProductCounts] = await Promise.all([
      this.categories.productCountByCategorySlug(),
      this.categories.subcategoryCountsByCategoryId(),
      this.subcategories.findByCategory(category.id),
      this.subcategories.productCountsBySubcategoryId(),
    ])
    const sub = subCounts.get(category.id) ?? { total: 0, active: 0 }
    return {
      category: serializeCategory(category, {
        subcategories: sub.total,
        activeSubcategories: sub.active,
        products: productCounts.get(category.slug) ?? 0,
      }),
      subcategories: subs.map((s) => serializeSubcategory(s, subProductCounts.get(s.id) ?? 0)),
    }
  }

  private async assertCategoryNameFree(name: string, excludeId?: string) {
    const clash = await this.categories.findByNameInsensitive(name, excludeId)
    if (clash) throw AppError.conflict(DUPLICATE_CATEGORY_NAME)
  }

  async create(input: CategoryInput) {
    await this.assertCategoryNameFree(input.name)
    try {
      const category = await this.categories.createCategory(input)
      return { category: serializeCategory(category, { subcategories: 0, activeSubcategories: 0, products: 0 }) }
    } catch (e: unknown) {
      if (isDuplicateKey(e)) throw AppError.conflict(DUPLICATE_CATEGORY_SLUG)
      throw e
    }
  }

  async update(id: string, patch: CategoryWritePatch) {
    const current = await this.categories.findRawBySlugOrId(id)
    if (!current) throw AppError.notFound('Categoría no encontrada')
    if (patch.name !== undefined) await this.assertCategoryNameFree(patch.name, String(current._id))
    try {
      const updated = await this.categories.updateCategory(String(current._id), patch)
      if (!updated) throw AppError.notFound('Categoría no encontrada')
      return { category: await this.serializeWithCounts(updated) }
    } catch (e: unknown) {
      if (isDuplicateKey(e)) throw AppError.conflict(DUPLICATE_CATEGORY_SLUG)
      throw e
    }
  }

  async setStatus(id: string, status: CatalogStatus) {
    const updated = await this.categories.updateCategory(id, { status })
    if (!updated) throw AppError.notFound('Categoría no encontrada')
    return { category: await this.serializeWithCounts(updated) }
  }

  /**
   * Solo se elimina una categoría sin subcategorías ni productos asignados.
   * Desactivarla es la vía para retirarla de la tienda sin perder historial.
   */
  async delete(id: string) {
    const current = await this.categories.findRawBySlugOrId(id)
    if (!current) throw AppError.notFound('Categoría no encontrada')
    const subCount = await this.categories.countSubcategories(current._id as never)
    if (subCount > 0) {
      throw AppError.conflict(
        `La categoría tiene ${subCount} subcategoría(s). Elimínalas o desactiva la categoría en su lugar.`,
      )
    }
    const productCounts = await this.categories.productCountByCategorySlug()
    const products = productCounts.get(current.slug) ?? 0
    if (products > 0) {
      throw AppError.conflict(
        `La categoría tiene ${products} producto(s) asignado(s). Desactívala en su lugar.`,
      )
    }
    const ok = await this.categories.deleteCategory(String(current._id))
    if (!ok) throw AppError.notFound('Categoría no encontrada')
    return { ok: true }
  }

  private async serializeWithCounts(c: CategoryDomain) {
    const [productCounts, subCounts] = await Promise.all([
      this.categories.productCountByCategorySlug(),
      this.categories.subcategoryCountsByCategoryId(),
    ])
    const sub = subCounts.get(c.id) ?? { total: 0, active: 0 }
    return serializeCategory(c, {
      subcategories: sub.total,
      activeSubcategories: sub.active,
      products: productCounts.get(c.slug) ?? 0,
    })
  }

  // ─── Subcategorías ───

  async listSubcategories(categoryIdOrSlug: string) {
    const category = await this.categories.findBySlugOrId(categoryIdOrSlug)
    if (!category) throw AppError.notFound('Categoría no encontrada')
    const [items, counts] = await Promise.all([
      this.subcategories.findByCategory(category.id),
      this.subcategories.productCountsBySubcategoryId(),
    ])
    const subcategories = items.map((s) => serializeSubcategory(s, counts.get(s.id) ?? 0))
    return { subcategories, items: subcategories }
  }

  private async assertSubcategoryNameFree(categoryId: string, name: string, excludeId?: string) {
    const clash = await this.subcategories.findByNameInCategory(categoryId, name, excludeId)
    if (clash) throw AppError.conflict(DUPLICATE_SUBCATEGORY_NAME)
  }

  async createSubcategory(categoryIdOrSlug: string, input: CategoryInput) {
    const category = await this.categories.findRawBySlugOrId(categoryIdOrSlug)
    if (!category) throw AppError.notFound('Categoría no encontrada')
    const categoryId = String(category._id)
    await this.assertSubcategoryNameFree(categoryId, input.name)
    try {
      const sub = await this.subcategories.createSubcategory({ ...input, category_id: categoryId })
      return { subcategory: serializeSubcategory(sub, 0) }
    } catch (e: unknown) {
      if (isDuplicateKey(e)) throw AppError.conflict(DUPLICATE_SUBCATEGORY_SLUG)
      throw e
    }
  }

  async updateSubcategory(id: string, patch: SubcategoryWritePatch) {
    const current = await this.subcategories.findRawById(id)
    if (!current) throw AppError.notFound('Subcategoría no encontrada')
    const categoryId = String(current.category_id)
    if (patch.name !== undefined) await this.assertSubcategoryNameFree(categoryId, patch.name, id)
    try {
      const updated = await this.subcategories.updateSubcategory(id, patch)
      if (!updated) throw AppError.notFound('Subcategoría no encontrada')
      const count = await this.subcategories.productCountBySubcategoryId(id)
      return { subcategory: serializeSubcategory(updated, count) }
    } catch (e: unknown) {
      if (isDuplicateKey(e)) throw AppError.conflict(DUPLICATE_SUBCATEGORY_SLUG)
      throw e
    }
  }

  async setSubcategoryStatus(id: string, status: CatalogStatus) {
    const updated = await this.subcategories.updateSubcategory(id, { status })
    if (!updated) throw AppError.notFound('Subcategoría no encontrada')
    const count = await this.subcategories.productCountBySubcategoryId(id)
    return { subcategory: serializeSubcategory(updated, count) }
  }

  /** No se elimina una subcategoría con productos: primero hay que reasignarlos o desactivarla. */
  async deleteSubcategory(id: string) {
    const current = await this.subcategories.findRawById(id)
    if (!current) throw AppError.notFound('Subcategoría no encontrada')
    const count = await this.subcategories.productCountBySubcategoryId(id)
    if (count > 0) {
      throw AppError.conflict(
        `La subcategoría tiene ${count} producto(s) asignado(s). Reasígnalos antes de eliminarla o desactívala.`,
      )
    }
    const ok = await this.subcategories.deleteSubcategory(id)
    if (!ok) throw AppError.notFound('Subcategoría no encontrada')
    return { ok: true }
  }
}

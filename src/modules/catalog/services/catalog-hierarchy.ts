import type { CategoryRepository } from '../infrastructure/category.repository.js'
import type { SubcategoryRepository } from '../infrastructure/subcategory.repository.js'

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i

export interface ProductHierarchyFilter {
  /** Slug de categoría (campo derivado category_slug en productos). */
  categorySlug?: string
  /** _id de subcategoría (campo subcategory_id en productos). */
  subcategoryId?: string
  /** true cuando los parámetros no corresponden a nada existente: el listado debe salir vacío. */
  empty: boolean
}

/**
 * Traduce los parámetros de filtro `category` y `subcategory` (slug o id) a filtros de productos.
 * La subcategoría con slug solo es resoluble dentro de una categoría (slugs únicos por ámbito).
 */
export async function resolveProductHierarchyFilter(
  categories: CategoryRepository,
  subcategories: SubcategoryRepository,
  categoryParam?: string,
  subcategoryParam?: string,
): Promise<ProductHierarchyFilter> {
  const categorySlug = categoryParam?.split(',')[0]?.trim() || undefined
  const subParam = subcategoryParam?.trim() || undefined

  if (!subParam) return { categorySlug, empty: false }

  if (OBJECT_ID_RE.test(subParam)) {
    const sub = await subcategories.findRawById(subParam)
    if (!sub) return { categorySlug, empty: true }
    if (categorySlug) {
      const cat = await categories.findRawBySlugOrId(categorySlug)
      if (!cat || String(cat._id) !== String(sub.category_id)) return { categorySlug, empty: true }
    }
    return { subcategoryId: subParam, empty: false }
  }

  if (!categorySlug) return { empty: true }
  const cat = await categories.findRawBySlugOrId(categorySlug)
  if (!cat) return { categorySlug, empty: true }
  const sub = await subcategories.findBySlugInCategory(String(cat._id), subParam)
  if (!sub) return { categorySlug, empty: true }
  return { categorySlug, subcategoryId: sub.id, empty: false }
}

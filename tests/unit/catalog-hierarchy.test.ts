import { describe, it, expect, vi } from 'vitest'
import { resolveProductHierarchyFilter } from '../../src/modules/catalog/services/catalog-hierarchy.js'

const CAT_ID = '65a000000000000000000001'
const SUB_ID = '65a000000000000000000002'
const OTHER_CAT_ID = '65a000000000000000000003'

function repos() {
  const categories = {
    findRawBySlugOrId: vi.fn(async (idOrSlug: string) =>
      idOrSlug === 'velas' ? { _id: CAT_ID, slug: 'velas' } : null,
    ),
  }
  const subcategories = {
    findRawById: vi.fn(async (id: string) =>
      id === SUB_ID ? { _id: SUB_ID, category_id: CAT_ID } : null,
    ),
    findBySlugInCategory: vi.fn(async (catId: string, slug: string) =>
      catId === CAT_ID && slug === 'dia-de-la-madre' ? { id: SUB_ID } : null,
    ),
  }
  return { categories, subcategories }
}

describe('resolveProductHierarchyFilter', () => {
  it('passes the category slug through when no subcategory is requested', async () => {
    const { categories, subcategories } = repos()
    const r = await resolveProductHierarchyFilter(categories as never, subcategories as never, 'velas')
    expect(r).toEqual({ categorySlug: 'velas', empty: false })
  })

  it('resolves a subcategory slug inside its category', async () => {
    const { categories, subcategories } = repos()
    const r = await resolveProductHierarchyFilter(
      categories as never,
      subcategories as never,
      'velas',
      'dia-de-la-madre',
    )
    expect(r).toEqual({ categorySlug: 'velas', subcategoryId: SUB_ID, empty: false })
  })

  it('returns empty for a subcategory slug without a category (slugs are scoped)', async () => {
    const { categories, subcategories } = repos()
    const r = await resolveProductHierarchyFilter(categories as never, subcategories as never, undefined, 'dia-de-la-madre')
    expect(r.empty).toBe(true)
  })

  it('returns empty when the subcategory id belongs to another category', async () => {
    const { categories, subcategories } = repos()
    subcategories.findRawById.mockResolvedValueOnce({ _id: SUB_ID, category_id: OTHER_CAT_ID } as never)
    const r = await resolveProductHierarchyFilter(categories as never, subcategories as never, 'velas', SUB_ID)
    expect(r.empty).toBe(true)
  })

  it('returns empty for an unknown category', async () => {
    const { categories, subcategories } = repos()
    const r = await resolveProductHierarchyFilter(categories as never, subcategories as never, 'nope', 'x')
    expect(r.empty).toBe(true)
  })
})

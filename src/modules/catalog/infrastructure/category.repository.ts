import type { Db, ObjectId as ObjectIdType } from 'mongodb'
import { BaseRepository, getCollection } from '../../../database/repositories/base.repository.js'
import {
  toCategoryDomain,
  type CatalogStatus,
  type CategoryDomain,
  type CategoryEntity,
} from '../domain/catalog.entity.js'

export interface CategoryWritePatch {
  name?: string
  slug?: string
  description?: string | null
  image_path?: string | null
  status?: CatalogStatus
  sort_order?: number
}

/** Filtro de registros activos. Documentos legacy sin status cuentan como activos. */
export function activeFilter(): Record<string, unknown> {
  return { $or: [{ status: 'active' }, { status: { $exists: false } }] }
}

function buildListFilter(search: string | undefined, opts: { onlyActive?: boolean }): Record<string, unknown> {
  const clauses: Record<string, unknown>[] = []
  if (opts.onlyActive) clauses.push(activeFilter())
  if (search) {
    clauses.push({
      $or: [
        { name: { $regex: search, $options: 'i' } },
        { slug: { $regex: search, $options: 'i' } },
      ],
    })
  }
  if (clauses.length === 0) return {}
  return clauses.length === 1 ? clauses[0]! : { $and: clauses }
}

/** Collation para comparar nombres sin distinguir mayúsculas ni acentos. */
export const NAME_COLLATION = { locale: 'es', strength: 1 } as const

export class CategoryRepository extends BaseRepository<CategoryEntity> {
  private readonly db: Db

  constructor(db: Db) {
    super(getCollection(db, 'categories'))
    this.db = db
  }

  async ensureIndexes(): Promise<void> {
    await super.ensureIndexes([
      { key: { slug: 1 }, unique: true },
      { key: { status: 1, sort_order: 1 } },
    ])
  }

  /** Listado para admin (todas) o público (solo activas). */
  async findAll(opts: { onlyActive?: boolean } = {}): Promise<CategoryDomain[]> {
    const filter = opts.onlyActive ? activeFilter() : {}
    const docs = await this.findMany(filter as never, { sort: { sort_order: 1, name: 1 } })
    return docs.map(toCategoryDomain)
  }

  async findPaged(
    skip: number,
    limit: number,
    search?: string,
    opts: { onlyActive?: boolean } = {},
  ): Promise<CategoryDomain[]> {
    const docs = await this.findMany(buildListFilter(search, opts) as never, {
      skip,
      limit,
      sort: { sort_order: 1, name: 1 },
    })
    return docs.map(toCategoryDomain)
  }

  async countAll(search?: string, opts: { onlyActive?: boolean } = {}): Promise<number> {
    return this.count(buildListFilter(search, opts) as never)
  }

  async findRawBySlugOrId(idOrSlug: string) {
    const { ObjectId } = await import('mongodb')
    let doc = await this.findOne({ slug: idOrSlug } as never)
    if (!doc && ObjectId.isValid(idOrSlug) && /^[a-f0-9]{24}$/i.test(idOrSlug)) {
      doc = await this.findById(idOrSlug)
    }
    return doc
  }

  async findBySlugOrId(idOrSlug: string): Promise<CategoryDomain | null> {
    const doc = await this.findRawBySlugOrId(idOrSlug)
    return doc ? toCategoryDomain(doc) : null
  }

  async findBySlug(slug: string): Promise<CategoryDomain | null> {
    const doc = await this.findOne({ slug } as never)
    return doc ? toCategoryDomain(doc) : null
  }

  /** Busca por nombre sin distinguir mayúsculas/acentos, excluyendo opcionalmente un id. */
  async findByNameInsensitive(name: string, excludeId?: string): Promise<CategoryDomain | null> {
    const { ObjectId } = await import('mongodb')
    const filter: Record<string, unknown> = { name: name.trim() }
    if (excludeId && ObjectId.isValid(excludeId)) filter._id = { $ne: new ObjectId(excludeId) }
    const doc = await this.collection.findOne(filter as never, { collation: NAME_COLLATION })
    return doc ? toCategoryDomain(doc) : null
  }

  async createCategory(input: {
    name: string
    slug: string
    description?: string | null
    image_path?: string | null
    status?: CatalogStatus
    sort_order?: number
  }): Promise<CategoryDomain> {
    const now = new Date()
    const id = await this.insertOne({
      name: input.name,
      slug: input.slug,
      description: input.description ?? null,
      image_path: input.image_path ?? null,
      status: input.status ?? 'active',
      sort_order: input.sort_order ?? 0,
      createdAt: now,
      updatedAt: now,
    } as never)
    const doc = await this.findById(id)
    if (!doc) throw new Error('Failed to create category')
    return toCategoryDomain(doc)
  }

  async updateCategory(idOrSlug: string, patch: CategoryWritePatch): Promise<CategoryDomain | null> {
    const doc = await this.findRawBySlugOrId(idOrSlug)
    if (!doc) return null
    await this.collection.updateOne(
      { _id: doc._id } as never,
      { $set: { ...patch, updatedAt: new Date() } },
    )
    // category_slug de los productos es derivado: si cambia el slug, se actualiza en los productos de esa categoría.
    if (patch.slug && patch.slug !== doc.slug) {
      await this.db
        .collection('products')
        .updateMany({ category_slug: doc.slug }, { $set: { category_slug: patch.slug } })
    }
    const updated = await this.findById(String(doc._id))
    return updated ? toCategoryDomain(updated) : null
  }

  async deleteCategory(idOrSlug: string): Promise<boolean> {
    const doc = await this.findRawBySlugOrId(idOrSlug)
    if (!doc) return false
    const res = await this.collection.deleteOne({ _id: doc._id } as never)
    return res.deletedCount > 0
  }

  /** Nº de productos por slug de categoría (campo derivado category_slug). */
  async productCountByCategorySlug(): Promise<Map<string, number>> {
    const rows = await this.db
      .collection('products')
      .aggregate([{ $group: { _id: '$category_slug', n: { $sum: 1 } } }])
      .toArray()
    const map = new Map<string, number>()
    for (const r of rows) {
      const key = r._id != null && r._id !== '' ? String(r._id) : null
      if (key) map.set(key, typeof r.n === 'number' ? r.n : 0)
    }
    return map
  }

  /** Nº de subcategorías por categoría: total y activas. */
  async subcategoryCountsByCategoryId(): Promise<Map<string, { total: number; active: number }>> {
    const rows = await this.db
      .collection('subcategories')
      .aggregate([
        {
          $group: {
            _id: '$category_id',
            total: { $sum: 1 },
            active: { $sum: { $cond: [{ $eq: ['$status', 'inactive'] }, 0, 1] } },
          },
        },
      ])
      .toArray()
    const map = new Map<string, { total: number; active: number }>()
    for (const r of rows) map.set(String(r._id), { total: r.total, active: r.active })
    return map
  }

  async countSubcategories(categoryId: ObjectIdType): Promise<number> {
    return this.db.collection('subcategories').countDocuments({ category_id: categoryId })
  }
}

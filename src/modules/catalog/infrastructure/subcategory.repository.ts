import type { Db } from 'mongodb'
import { BaseRepository, getCollection } from '../../../database/repositories/base.repository.js'
import {
  toSubcategoryDomain,
  type CatalogStatus,
  type SubcategoryDomain,
  type SubcategoryEntity,
} from '../domain/catalog.entity.js'
import { NAME_COLLATION, activeFilter } from './category.repository.js'

export interface SubcategoryWritePatch {
  name?: string
  slug?: string
  description?: string | null
  image_path?: string | null
  status?: CatalogStatus
  sort_order?: number
}

export class SubcategoryRepository extends BaseRepository<SubcategoryEntity> {
  private readonly db: Db

  constructor(db: Db) {
    super(getCollection(db, 'subcategories'))
    this.db = db
  }

  async ensureIndexes(): Promise<void> {
    await super.ensureIndexes([
      { key: { category_id: 1, slug: 1 }, unique: true },
      { key: { category_id: 1, status: 1, sort_order: 1 } },
    ])
  }

  /** Subcategorías de una categoría. onlyActive excluye las inactivas (selectores de asignación). */
  async findByCategory(categoryId: string, opts: { onlyActive?: boolean } = {}): Promise<SubcategoryDomain[]> {
    const { ObjectId } = await import('mongodb')
    if (!ObjectId.isValid(categoryId)) return []
    const filter: Record<string, unknown> = { category_id: new ObjectId(categoryId) }
    if (opts.onlyActive) filter.$and = [activeFilter()]
    const docs = await this.findMany(filter as never, { sort: { sort_order: 1, name: 1 } })
    return docs.map(toSubcategoryDomain)
  }

  async findRawById(id: string) {
    return this.findById(id)
  }

  /** Todas las subcategorías (admin y etiquetas de producto). */
  async findAllDomain(): Promise<SubcategoryDomain[]> {
    const docs = await this.findMany({} as never)
    return docs.map(toSubcategoryDomain)
  }

  async findBySlugInCategory(categoryId: string, slug: string): Promise<SubcategoryDomain | null> {
    const { ObjectId } = await import('mongodb')
    if (!ObjectId.isValid(categoryId)) return null
    const doc = await this.findOne({ category_id: new ObjectId(categoryId), slug } as never)
    return doc ? toSubcategoryDomain(doc) : null
  }

  /** Nombre único dentro de la categoría, sin distinguir mayúsculas/acentos. */
  async findByNameInCategory(categoryId: string, name: string, excludeId?: string): Promise<SubcategoryDomain | null> {
    const { ObjectId } = await import('mongodb')
    const filter: Record<string, unknown> = { category_id: new ObjectId(categoryId), name: name.trim() }
    if (excludeId && ObjectId.isValid(excludeId)) filter._id = { $ne: new ObjectId(excludeId) }
    const doc = await this.collection.findOne(filter as never, { collation: NAME_COLLATION })
    return doc ? toSubcategoryDomain(doc) : null
  }

  async createSubcategory(input: {
    category_id: string
    name: string
    slug: string
    description?: string | null
    image_path?: string | null
    status?: CatalogStatus
    sort_order?: number
  }): Promise<SubcategoryDomain> {
    const { ObjectId } = await import('mongodb')
    const now = new Date()
    const id = await this.insertOne({
      category_id: new ObjectId(input.category_id),
      name: input.name,
      slug: input.slug,
      description: input.description ?? null,
      image_path: input.image_path ?? null,
      status: input.status ?? 'active',
      sort_order: input.sort_order ?? 0,
      created_at: now,
      updated_at: now,
    } as never)
    const doc = await this.findById(id)
    if (!doc) throw new Error('Failed to create subcategory')
    return toSubcategoryDomain(doc)
  }

  async updateSubcategory(id: string, patch: SubcategoryWritePatch): Promise<SubcategoryDomain | null> {
    const { ObjectId } = await import('mongodb')
    if (!ObjectId.isValid(id)) return null
    const res = await this.collection.updateOne(
      { _id: new ObjectId(id) } as never,
      { $set: { ...patch, updated_at: new Date() } },
    )
    if (!res.matchedCount) return null
    const doc = await this.findById(id)
    return doc ? toSubcategoryDomain(doc) : null
  }

  async deleteSubcategory(id: string): Promise<boolean> {
    return this.deleteById(id)
  }

  /** Nº de productos asignados por subcategoría (clave: id string). */
  async productCountsBySubcategoryId(): Promise<Map<string, number>> {
    const rows = await this.db
      .collection('products')
      .aggregate([
        { $match: { subcategory_id: { $ne: null } } },
        { $group: { _id: '$subcategory_id', n: { $sum: 1 } } },
      ])
      .toArray()
    const map = new Map<string, number>()
    for (const r of rows) map.set(String(r._id), typeof r.n === 'number' ? r.n : 0)
    return map
  }

  async productCountBySubcategoryId(id: string): Promise<number> {
    const { ObjectId } = await import('mongodb')
    if (!ObjectId.isValid(id)) return 0
    return this.db.collection('products').countDocuments({ subcategory_id: new ObjectId(id) })
  }
}

import type { Db } from 'mongodb'
import { BaseRepository, getCollection } from '../../../database/repositories/base.repository.js'
import {
  toCategoryDomain,
  type CategoryDomain,
  type CategoryEntity,
} from '../domain/catalog.entity.js'

export class CategoryRepository extends BaseRepository<CategoryEntity> {
  constructor(db: Db) {
    super(getCollection(db, 'categories'))
  }

  async ensureIndexes(): Promise<void> {
    await super.ensureIndexes([{ key: { slug: 1 }, unique: true }])
  }

  async findAll(): Promise<CategoryDomain[]> {
    const docs = await this.findMany({}, { sort: { name: 1 } })
    return docs.map(toCategoryDomain)
  }

  async findPaged(skip: number, limit: number, search?: string): Promise<CategoryDomain[]> {
    const filter = search
      ? ({
          $or: [
            { name: { $regex: search, $options: 'i' } },
            { slug: { $regex: search, $options: 'i' } },
          ],
        } as never)
      : ({} as never)
    const docs = await this.findMany(filter, { skip, limit, sort: { name: 1 } })
    return docs.map(toCategoryDomain)
  }

  async countAll(search?: string): Promise<number> {
    const filter = search
      ? ({
          $or: [
            { name: { $regex: search, $options: 'i' } },
            { slug: { $regex: search, $options: 'i' } },
          ],
        } as never)
      : ({} as never)
    return this.count(filter)
  }

  async findBySlugOrId(idOrSlug: string): Promise<CategoryDomain | null> {
    let doc = await this.findOne({ slug: idOrSlug } as never)
    if (!doc && idOrSlug.match(/^[a-f0-9]{24}$/i)) {
      doc = await this.findById(idOrSlug)
    }
    return doc ? toCategoryDomain(doc) : null
  }

  async createCategory(name: string, slug: string): Promise<CategoryDomain> {
    const now = new Date()
    const id = await this.insertOne({ name, slug, createdAt: now } as never)
    const doc = await this.findById(id)
    if (!doc) throw new Error('Failed to create category')
    return toCategoryDomain(doc)
  }

  async updateCategory(idOrSlug: string, patch: { name?: string; slug?: string }): Promise<CategoryDomain | null> {
    const { ObjectId } = await import('mongodb')
    let filter: Record<string, unknown> = { slug: idOrSlug }
    if (ObjectId.isValid(idOrSlug)) filter = { _id: new ObjectId(idOrSlug) }
    const res = await this.collection.updateOne(filter as never, { $set: patch })
    if (!res.matchedCount) return null
    const doc = await this.findOne(filter as never)
    return doc ? toCategoryDomain(doc) : null
  }

  async deleteCategory(idOrSlug: string): Promise<boolean> {
    const { ObjectId } = await import('mongodb')
    if (ObjectId.isValid(idOrSlug)) return this.deleteById(idOrSlug)
    const res = await this.collection.deleteOne({ slug: idOrSlug } as never)
    return res.deletedCount > 0
  }

  async findBySlug(slug: string): Promise<CategoryDomain | null> {
    const doc = await this.findOne({ slug } as never)
    return doc ? toCategoryDomain(doc) : null
  }

  async productCountByCategorySlug(): Promise<Map<string, number>> {
    const rows = await this.collection.db
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
}

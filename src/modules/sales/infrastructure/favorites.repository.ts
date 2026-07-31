import type { Db } from 'mongodb'
import { BaseRepository, getCollection } from '../../../database/repositories/base.repository.js'

const MAX_FAVORITES = 30
const TTL_MS = 30 * 24 * 60 * 60 * 1000

interface FavoriteDocument {
  userId: string
  productSlug: string
  createdAt: Date
  expiresAt: Date
}

export class FavoritesRepository extends BaseRepository<FavoriteDocument> {
  constructor(db: Db) {
    super(getCollection(db, 'user_favorites'))
  }

  async ensureIndexes(): Promise<void> {
    await super.ensureIndexes([
      { key: { userId: 1, productSlug: 1 }, unique: true },
      { key: { userId: 1, expiresAt: 1 } },
    ])
  }

  private async purgeExpired(userId: string) {
    await this.collection.deleteMany({ userId, expiresAt: { $lt: new Date() } })
  }

  async listSlugs(userId: string): Promise<string[]> {
    await this.purgeExpired(userId)
    const now = new Date()
    const rows = await this.findMany(
      { userId, expiresAt: { $gte: now } } as never,
      { sort: { createdAt: -1 }, limit: MAX_FAVORITES },
    )
    return rows.map((r) => r.productSlug)
  }

  async mergeSlugs(userId: string, slugs: string[]): Promise<string[]> {
    await this.purgeExpired(userId)
    const existing = await this.listSlugs(userId)
    const merged = [...new Set([...existing, ...slugs.map((s) => s.trim()).filter(Boolean)])].slice(
      0,
      MAX_FAVORITES,
    )
    const now = new Date()
    const expiresAt = new Date(now.getTime() + TTL_MS)
    for (const productSlug of merged) {
      await this.collection.updateOne(
        { userId, productSlug },
        { $set: { userId, productSlug, createdAt: now, expiresAt } },
        { upsert: true },
      )
    }
    return merged
  }

  async toggle(userId: string, productSlug: string): Promise<boolean> {
    await this.purgeExpired(userId)
    const slug = productSlug.trim()
    const existing = await this.findOne({ userId, productSlug: slug } as never)
    if (existing) {
      await this.collection.deleteOne({ userId, productSlug: slug })
      return false
    }
    const count = await this.collection.countDocuments({
      userId,
      expiresAt: { $gte: new Date() },
    })
    if (count >= MAX_FAVORITES) {
      throw new Error('FAVORITES_LIMIT')
    }
    const now = new Date()
    await this.collection.insertOne({
      userId,
      productSlug: slug,
      createdAt: now,
      expiresAt: new Date(now.getTime() + TTL_MS),
    })
    return true
  }

  async countDistinctUsers(now: Date): Promise<number> {
    const rows = await this.collection
      .aggregate([
        { $match: { expiresAt: { $gte: now } } },
        { $group: { _id: '$userId' } },
        { $count: 'n' },
      ])
      .toArray()
    return typeof rows[0]?.n === 'number' ? rows[0].n : 0
  }

  async topProductSlugs(limit: number): Promise<Array<{ slug: string; favorites: number }>> {
    const now = new Date()
    const rows = await this.collection
      .aggregate([
        { $match: { expiresAt: { $gte: now } } },
        { $group: { _id: '$productSlug', n: { $sum: 1 } } },
        { $sort: { n: -1 } },
        { $limit: limit },
      ])
      .toArray()
    return rows.map((r) => ({ slug: String(r._id), favorites: r.n as number }))
  }
}

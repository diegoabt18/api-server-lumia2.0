import type { Db } from 'mongodb'
import { ObjectId } from 'mongodb'
import { getCollection } from '../../../database/repositories/base.repository.js'
import type { StoreBannerEntity, StoreBannerPosition } from '../domain/store-banner.entity.js'

function resolveStoreBannerHref(
  b: Pick<StoreBannerEntity, 'cta_href' | 'promotion_id' | 'category_slug' | 'collection_slug'>,
): string {
  const explicit = b.cta_href?.trim()
  if (explicit) {
    if (explicit.startsWith('http://') || explicit.startsWith('https://') || explicit.startsWith('/')) {
      return explicit
    }
    return `/${explicit.replace(/^\//, '')}`
  }
  const pid = b.promotion_id?.trim()
  if (pid) return `/products?promotionId=${encodeURIComponent(pid)}`
  const cat = b.category_slug?.trim()
  if (cat) return `/products?category=${encodeURIComponent(cat)}`
  const col = b.collection_slug?.trim()
  if (col) return `/products?collection=${encodeURIComponent(col)}`
  return '/products'
}

export class StoreBannerRepository {
  private readonly collection

  constructor(db: Db) {
    this.collection = getCollection<StoreBannerEntity>(db, 'store_banners')
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndexes([
      { key: { active: 1, position: 1, starts_at: 1, ends_at: 1, priority: 1 } },
    ])
  }

  async findPublicVisible(now: Date, positions?: StoreBannerPosition[]): Promise<StoreBannerEntity[]> {
    const q: Record<string, unknown> = {
      active: true,
      starts_at: { $lte: now },
      ends_at: { $gte: now },
    }
    if (positions?.length) q.position = { $in: positions }
    return this.collection.find(q as never).sort({ priority: 1, _id: 1 }).toArray()
  }

  toPublicDto(e: StoreBannerEntity) {
    return {
      id: String(e._id),
      position: e.position,
      priority: typeof e.priority === 'number' ? e.priority : 100,
      imageUrl: e.image_url,
      title: e.title ?? null,
      subtitle: e.subtitle ?? null,
      ctaLabel: e.cta_label ?? null,
      href: resolveStoreBannerHref(e),
    }
  }

  async listAll(): Promise<StoreBannerEntity[]> {
    return this.collection.find({}).sort({ position: 1, priority: 1, _id: 1 }).toArray()
  }

  async findByIdSafe(id: string): Promise<StoreBannerEntity | null> {
    if (!ObjectId.isValid(id)) return null
    return this.collection.findOne({ _id: new ObjectId(id) } as never)
  }

  async insertBanner(doc: Omit<StoreBannerEntity, '_id'>): Promise<string> {
    const { insertedId } = await this.collection.insertOne(doc as never)
    return insertedId.toString()
  }

  async replaceById(id: string, doc: Omit<StoreBannerEntity, '_id'>): Promise<boolean> {
    if (!ObjectId.isValid(id)) return false
    const full = { ...doc, _id: new ObjectId(id) } as StoreBannerEntity
    const r = await this.collection.replaceOne({ _id: new ObjectId(id) } as never, full as never)
    return r.matchedCount > 0
  }

  async deleteById(id: string): Promise<boolean> {
    if (!ObjectId.isValid(id)) return false
    const r = await this.collection.deleteOne({ _id: new ObjectId(id) } as never)
    return r.deletedCount > 0
  }

  adminSerialize(e: StoreBannerEntity) {
    const startsAt = e.starts_at instanceof Date ? e.starts_at : new Date(String(e.starts_at))
    const endsAt = e.ends_at instanceof Date ? e.ends_at : new Date(String(e.ends_at))
    return {
      id: String(e._id),
      active: e.active !== false,
      position: e.position,
      priority: typeof e.priority === 'number' ? e.priority : 100,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      imageUrl: e.image_url,
      title: e.title ?? null,
      subtitle: e.subtitle ?? null,
      ctaLabel: e.cta_label ?? null,
      ctaHref: e.cta_href ?? null,
      promotionId: e.promotion_id ?? null,
      categorySlug: e.category_slug ?? null,
      collectionSlug: e.collection_slug ?? null,
      createdAt: e.created_at instanceof Date ? e.created_at.toISOString() : null,
      updatedAt: e.updated_at instanceof Date ? e.updated_at.toISOString() : null,
    }
  }
}

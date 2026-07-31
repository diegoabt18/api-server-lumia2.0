import { ObjectId, type Db } from 'mongodb'
import { BaseRepository, getCollection } from '../../../database/repositories/base.repository.js'

interface ReviewDocument {
  product_slug: string
  user_id: string
  user_name: string
  user_avatar?: string
  stars: number
  title?: string
  body: string
  verified_purchase: boolean
  helpful_count: number
  hidden?: boolean
  created_at: Date
}

export class ReviewRepository extends BaseRepository<ReviewDocument & { _id: ObjectId }> {
  constructor(db: Db) {
    super(getCollection(db, 'product_reviews'))
  }

  async ensureIndexes(): Promise<void> {
    await super.ensureIndexes([
      { key: { product_slug: 1, created_at: -1 } },
      { key: { product_slug: 1, user_id: 1 }, unique: true },
    ])
  }

  async list(productSlug: string, page: number, limit: number) {
    const filter = { product_slug: productSlug, hidden: { $ne: true } }
    const skip = (page - 1) * limit
    const [reviews, total, agg] = await Promise.all([
      this.collection.find(filter).sort({ created_at: -1 }).skip(skip).limit(limit).toArray(),
      this.collection.countDocuments(filter),
      this.collection
        .aggregate([
          { $match: filter },
          { $group: { _id: null, average: { $avg: '$stars' }, count: { $sum: 1 } } },
        ])
        .toArray(),
    ])

    return {
      rating: {
        average: Math.round(((agg[0]?.average as number) ?? 0) * 10) / 10,
        count: Number(agg[0]?.count ?? 0),
      },
      reviews: reviews.map((r) => ({
        id: r._id.toString(),
        userName: r.user_name,
        userAvatar: r.user_avatar ?? '',
        stars: r.stars,
        title: r.title ?? '',
        body: r.body,
        verifiedPurchase: r.verified_purchase,
        helpfulCount: r.helpful_count ?? 0,
        createdAt: r.created_at.toISOString(),
      })),
      pagination: {
        page,
        pages: Math.max(1, Math.ceil(total / limit)),
        total,
      },
    }
  }

  async upsert(
    productSlug: string,
    userId: string,
    userName: string,
    data: { stars: number; title?: string; body: string },
    verifiedPurchase: boolean,
  ) {
    const now = new Date()
    await this.collection.updateOne(
      { product_slug: productSlug, user_id: userId },
      {
        $set: {
          product_slug: productSlug,
          user_id: userId,
          user_name: userName,
          user_avatar: '',
          stars: data.stars,
          title: data.title ?? '',
          body: data.body,
          verified_purchase: verifiedPurchase,
          helpful_count: 0,
          hidden: false,
          created_at: now,
        },
      },
      { upsert: true },
    )
  }

  async hasPaidOrder(userId: string, productSlug: string): Promise<boolean> {
    const orders = getCollection<{
      userId?: string
      status?: string
      items?: Array<{ productSlug?: string }>
    }>(this.collection.db, 'orders')
    const found = await orders.findOne({
      userId,
      status: { $in: ['paid', 'shipped', 'delivered', 'pending'] },
      'items.productSlug': productSlug,
    } as never)
    return Boolean(found)
  }

  async adminPatch(id: string, patch: { hidden?: boolean; featured?: boolean }): Promise<boolean> {
    if (!ObjectId.isValid(id)) return false
    const res = await this.collection.updateOne(
      { _id: new ObjectId(id) } as never,
      { $set: { ...patch, updated_at: new Date() } },
    )
    return res.matchedCount > 0
  }
}

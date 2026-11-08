import { ObjectId, type Db, type Filter, type Sort } from 'mongodb'
import { BaseRepository, getCollection } from '../../../database/repositories/base.repository.js'

interface ReviewDocument {
  product_slug: string
  user_id: string
  user_name: string
  user_avatar?: string
  stars: number
  title?: string
  body: string
  images?: string[]
  verified_purchase: boolean
  helpful_count: number
  not_helpful_count?: number
  hidden?: boolean
  created_at: Date
  updated_at?: Date
}

export type ReviewReaction = 'helpful' | 'not_helpful'

/** Estados de orden que cuentan como compra verificada (mismo criterio que Lumia). */
const VERIFIED_ORDER_STATUSES = ['paid', 'shipped', 'delivered']

export class ReviewRepository extends BaseRepository<ReviewDocument & { _id: ObjectId }> {
  private readonly db: Db

  constructor(db: Db) {
    super(getCollection(db, 'product_reviews'))
    this.db = db
  }

  async ensureIndexes(): Promise<void> {
    await super.ensureIndexes([
      { key: { product_slug: 1, created_at: -1 } },
      { key: { product_slug: 1, user_id: 1 }, unique: true },
      { key: { product_slug: 1, stars: 1 } },
    ])
    await getCollection(this.db, 'review_reactions').createIndexes([
      // Sin `name` personalizado: el índice ya existe en la base con el nombre automático.
      { key: { review_id: 1, user_id: 1 }, unique: true },
    ])
  }

  /**
   * Lista reseñas visibles con distribución de estrellas. `hidden` nunca se expone.
   * Devuelve la forma flat (`page/pages/total`) que usa lumia2.0 y la forma por bloques
   * (`reviews`) que usa Lumia; ambas se construyen aquí para no obligar a cambios de cliente.
   */
  async list(
    productSlug: string,
    page: number,
    limit: number,
    opts: { stars?: number; verifiedOnly?: boolean; sort?: 'recent' | 'useful' } = {},
  ) {
    const base: Filter<ReviewDocument> = { product_slug: productSlug, hidden: { $ne: true } }
    const filter: Filter<ReviewDocument> = { ...base }
    if (opts.stars) filter.stars = opts.stars
    if (opts.verifiedOnly) filter.verified_purchase = true
    const sort: Sort = opts.sort === 'useful' ? { helpful_count: -1, created_at: -1 } : { created_at: -1 }
    const skip = (page - 1) * limit

    const [reviews, total, distributionRows] = await Promise.all([
      this.collection.find(filter).sort(sort).skip(skip).limit(limit).toArray(),
      this.collection.countDocuments(filter),
      this.collection
        .aggregate<{ _id: number; count: number }>([
          { $match: base },
          { $group: { _id: '$stars', count: { $sum: 1 } } },
        ])
        .toArray(),
    ])

    const distribution = [5, 4, 3, 2, 1].map((stars) => ({
      stars,
      count: Number(distributionRows.find((row) => Number(row._id) === stars)?.count ?? 0),
    }))
    const ratingCount = distribution.reduce((acc, row) => acc + row.count, 0)
    const average =
      ratingCount > 0
        ? Math.round((distribution.reduce((acc, row) => acc + row.stars * row.count, 0) / ratingCount) * 10) / 10
        : 0
    const pages = Math.max(1, Math.ceil(total / limit))

    return {
      rating: { average, count: ratingCount, distribution },
      reviews: reviews.map((r) => ({
        id: r._id.toString(),
        userId: r.user_id,
        userName: r.user_name,
        userAvatar: r.user_avatar ?? '',
        stars: r.stars,
        title: r.title ?? '',
        body: r.body,
        verifiedPurchase: r.verified_purchase,
        images: Array.isArray(r.images) ? r.images : [],
        helpfulCount: r.helpful_count ?? 0,
        notHelpfulCount: r.not_helpful_count ?? 0,
        createdAt: r.created_at.toISOString(),
      })),
      pagination: { page, pages, total },
    }
  }

  async findById(id: string) {
    if (!ObjectId.isValid(id)) return null
    return this.collection.findOne({ _id: new ObjectId(id) } as never)
  }

  /**
   * Crea o actualiza la reseña del usuario. Solo cambian el contenido y la compra verificada:
   * `created_at`, contadores de utilidad y `hidden` se conservan, para que una edición no
   * reactive una reseña moderada ni reinicie sus votos.
   */
  async upsert(
    productSlug: string,
    user: { id: string; name: string; avatar: string },
    data: { stars: number; title?: string; body?: string; images?: string[] },
    verifiedPurchase: boolean,
  ): Promise<void> {
    const now = new Date()
    await this.collection.updateOne(
      { product_slug: productSlug, user_id: user.id } as never,
      {
        $set: {
          user_name: user.name,
          user_avatar: user.avatar,
          stars: data.stars,
          title: data.title ?? '',
          body: data.body ?? '',
          images: (data.images ?? []).slice(0, 5),
          verified_purchase: verifiedPurchase,
          updated_at: now,
        },
        $setOnInsert: {
          product_slug: productSlug,
          user_id: user.id,
          created_at: now,
          helpful_count: 0,
          not_helpful_count: 0,
          hidden: false,
        },
      } as never,
      { upsert: true },
    )
  }

  /**
   * Registra un voto útil / no útil. Un usuario tiene un solo voto por reseña: cambiarlo
   * ajusta ambos contadores. Devuelve false si la reseña no existe o está oculta.
   */
  async react(reviewId: string, userId: string, reaction: ReviewReaction): Promise<boolean> {
    if (!ObjectId.isValid(reviewId)) return false
    const oid = new ObjectId(reviewId)
    const review = await this.collection.findOne({ _id: oid, hidden: { $ne: true } } as never)
    if (!review) return false

    const reactions = getCollection<{ review_id: ObjectId; user_id: string; reaction: ReviewReaction }>(
      this.db,
      'review_reactions',
    )
    const existing = await reactions.findOne({ review_id: oid, user_id: userId })
    if (existing?.reaction === reaction) return true

    await reactions.updateOne(
      { review_id: oid, user_id: userId },
      { $set: { reaction, created_at: new Date() } },
      { upsert: true },
    )
    const inc: Record<string, number> = {}
    if (reaction === 'helpful') {
      inc.helpful_count = 1
      if (existing?.reaction === 'not_helpful') inc.not_helpful_count = -1
    } else {
      inc.not_helpful_count = 1
      if (existing?.reaction === 'helpful') inc.helpful_count = -1
    }
    await this.collection.updateOne({ _id: oid } as never, { $inc: inc } as never)
    return true
  }

  async hasPaidOrder(userId: string, productSlug: string): Promise<boolean> {
    const orders = getCollection<{ userId?: string; status?: string; items?: Array<{ productSlug?: string }> }>(
      this.db,
      'orders',
    )
    const found = await orders.findOne({
      userId,
      status: { $in: VERIFIED_ORDER_STATUSES },
      'items.productSlug': productSlug,
    } as never)
    return Boolean(found)
  }

  /** Suma de votos y promedio visibles para el resumen del producto. */
  async visibleRatingSummary(productSlug: string): Promise<{ average: number; count: number }> {
    const [agg] = await this.collection
      .aggregate<{ average: number; count: number }>([
        { $match: { product_slug: productSlug, hidden: { $ne: true } } },
        { $group: { _id: null, average: { $avg: '$stars' }, count: { $sum: 1 } } },
      ])
      .toArray()
    return {
      average: Math.round(((agg?.average as number) ?? 0) * 10) / 10,
      count: Number(agg?.count ?? 0),
    }
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

import { AppError } from '../../../common/errors/app.error.js'
import type { ProductRepository } from '../../catalog/infrastructure/product.repository.js'
import type { ReviewRepository } from '../infrastructure/review.repository.js'
import type { submitReviewSchema } from '../schemas/store.schema.js'
import type { z } from 'zod'

export class FeedbackService {
  constructor(
    private readonly reviews: ReviewRepository,
    private readonly products: ProductRepository,
  ) {}

  async list(productSlug: string, page: number, limit: number) {
    const product = await this.products.findBySlugOrId(productSlug)
    if (!product) throw AppError.notFound('Product not found')
    return this.reviews.list(product.slug, page, limit)
  }

  async submit(
    productSlug: string,
    userId: string,
    userName: string,
    data: z.infer<typeof submitReviewSchema>,
  ) {
    const product = await this.products.findBySlugOrId(productSlug)
    if (!product) throw AppError.notFound('Product not found')

    const verified = await this.reviews.hasPaidOrder(userId, product.slug)
    await this.reviews.upsert(product.slug, userId, userName, data, verified)
    return { ok: true }
  }
}

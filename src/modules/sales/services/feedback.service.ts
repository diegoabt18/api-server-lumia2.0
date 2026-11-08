import { AppError } from '../../../common/errors/app.error.js'
import type { ProductRepository } from '../../catalog/infrastructure/product.repository.js'
import type { FeedbackReportRepository } from '../infrastructure/feedback-report.repository.js'
import type { QuestionRepository } from '../infrastructure/question.repository.js'
import type { ReviewRepository, ReviewReaction } from '../infrastructure/review.repository.js'
import { sanitizeFeedbackText } from '../schemas/feedback.schema.js'

export interface FeedbackAuthor {
  id: string
  name: string
  avatar: string
}

export interface FeedbackListOptions {
  reviewPage: number
  reviewLimit: number
  questionPage: number
  questionLimit: number
  stars?: number
  verifiedOnly?: boolean
  reviewSort?: 'recent' | 'useful'
}

/**
 * Reseñas, preguntas y reportes de producto. Escribe en sales_db y, cuando cambia la valoración,
 * actualiza el resumen denormalizado del producto en catalog_db.
 */
export class FeedbackService {
  constructor(
    private readonly reviews: ReviewRepository,
    private readonly questions: QuestionRepository,
    private readonly reports: FeedbackReportRepository,
    private readonly products: ProductRepository,
  ) {}

  private async requireProduct(productSlug: string) {
    const product = await this.products.findBySlugOrId(productSlug)
    if (!product) throw AppError.notFound('Product not found')
    return product
  }

  /**
   * Lectura pública. Mantiene la forma plana (`pagination.page/pages/total`) que usa lumia2.0 y
   * añade `questions` y `pagination.reviews/questions` que usa Lumia.
   */
  async list(productSlug: string, opts: FeedbackListOptions) {
    const product = await this.requireProduct(productSlug)
    const [reviewData, questionData] = await Promise.all([
      this.reviews.list(product.slug, opts.reviewPage, opts.reviewLimit, {
        stars: opts.stars,
        verifiedOnly: opts.verifiedOnly,
        sort: opts.reviewSort,
      }),
      this.questions.listForProduct(product.slug, opts.questionPage, opts.questionLimit),
    ])
    const reviewsPagination = {
      page: opts.reviewPage,
      limit: opts.reviewLimit,
      total: reviewData.pagination.total,
      pages: reviewData.pagination.pages,
    }
    const questionsPagination = {
      page: opts.questionPage,
      limit: opts.questionLimit,
      total: questionData.total,
      pages: questionData.pages,
    }
    return {
      rating: reviewData.rating,
      reviews: reviewData.reviews,
      questions: questionData.questions,
      pagination: {
        ...reviewData.pagination,
        reviews: reviewsPagination,
        questions: questionsPagination,
      },
    }
  }

  /** Crea o edita la reseña del usuario. Una sola por producto. */
  async submitReview(
    productSlug: string,
    author: FeedbackAuthor,
    data: { stars: number; title?: string; body?: string; images?: string[] },
  ) {
    const product = await this.requireProduct(productSlug)
    const verified = await this.reviews.hasPaidOrder(author.id, product.slug)
    await this.reviews.upsert(
      product.slug,
      { id: author.id, name: sanitizeFeedbackText(author.name, 120), avatar: sanitizeFeedbackText(author.avatar, 1000) },
      {
        stars: Math.min(5, Math.max(1, Math.round(data.stars))),
        title: sanitizeFeedbackText(data.title, 200),
        body: sanitizeFeedbackText(data.body, 4000),
        images: data.images,
      },
      verified,
    )
    await this.refreshRating(product.slug)
    return { ok: true as const }
  }

  async reactToReview(productSlug: string, reviewId: string, userId: string, reaction: ReviewReaction) {
    await this.requireProduct(productSlug)
    const ok = await this.reviews.react(reviewId, userId, reaction)
    if (!ok) throw AppError.notFound('Reseña no encontrada')
    return { ok: true as const }
  }

  async createQuestion(productSlug: string, author: FeedbackAuthor, body: string) {
    const product = await this.requireProduct(productSlug)
    return this.questions.createQuestion(
      product.slug,
      { id: author.id, name: sanitizeFeedbackText(author.name, 120), avatar: sanitizeFeedbackText(author.avatar, 1000) },
      sanitizeFeedbackText(body, 2000),
    )
  }

  /** Solo administradores publican respuestas oficiales. */
  async answerQuestion(
    productSlug: string,
    questionId: string,
    author: FeedbackAuthor,
    body: string,
    official: boolean,
  ) {
    await this.requireProduct(productSlug)
    const created = await this.questions.createAnswer(
      questionId,
      { id: author.id, name: sanitizeFeedbackText(author.name, 120), avatar: sanitizeFeedbackText(author.avatar, 1000) },
      sanitizeFeedbackText(body, 2500),
      official,
    )
    if (!created) throw AppError.notFound('Pregunta no encontrada')
    return created
  }

  async reactToQuestion(productSlug: string, questionId: string, userId: string, reaction: ReviewReaction) {
    await this.requireProduct(productSlug)
    const ok = await this.questions.react(questionId, userId, reaction)
    if (!ok) throw AppError.notFound('Pregunta no encontrada')
    return { ok: true as const }
  }

  async report(
    userId: string,
    input: { entityType: 'review' | 'question' | 'answer'; entityId: string; reason: string },
  ) {
    await this.reports.create({
      entityType: input.entityType,
      entityId: input.entityId.slice(0, 64),
      userId,
      reason: sanitizeFeedbackText(input.reason, 400),
    })
    return { ok: true as const }
  }

  /** Recalcula el resumen visible (sin reseñas ocultas) y lo guarda en el producto. */
  async refreshRating(productSlug: string): Promise<void> {
    const summary = await this.reviews.visibleRatingSummary(productSlug)
    await this.products.updateRatingSummary(productSlug, summary.average, summary.count)
  }
}

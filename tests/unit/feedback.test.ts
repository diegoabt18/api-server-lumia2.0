import { describe, it, expect, vi } from 'vitest'
import { FeedbackService } from '../../src/modules/sales/services/feedback.service.js'
import { AdminFeedbackService } from '../../src/modules/admin/services/admin-feedback.service.js'
import { ReviewRepository } from '../../src/modules/sales/infrastructure/review.repository.js'
import {
  questionWriteSchema,
  reviewWriteSchema,
  sanitizeFeedbackText,
} from '../../src/modules/sales/schemas/feedback.schema.js'
import { isAppError } from '../../src/common/errors/app.error.js'

function fakes(overrides: Partial<Record<string, unknown>> = {}) {
  const reviews = {
    list: vi.fn(async (..._args: unknown[]) => ({
      rating: { average: 4.5, count: 2, distribution: [{ stars: 5, count: 1 }, { stars: 4, count: 1 }] },
      reviews: [],
      pagination: { page: _args[1] as number, pages: 3, total: 21 },
    })),
    hasPaidOrder: vi.fn(async () => true),
    upsert: vi.fn(async (..._args: unknown[]) => undefined),
    react: vi.fn(async (..._args: unknown[]) => true),
    visibleRatingSummary: vi.fn(async () => ({ average: 4, count: 7 })),
    findById: vi.fn(async () => null),
    adminPatch: vi.fn(async (..._args: unknown[]) => true),
    ...(overrides.reviews as object),
  }
  const questions = {
    listForProduct: vi.fn(async () => ({ questions: [], total: 4, pages: 1 })),
    createQuestion: vi.fn(async () => ({ id: 'q1' })),
    createAnswer: vi.fn(async (..._args: unknown[]) => ({ id: 'a1' })),
    react: vi.fn(async () => true),
    ...(overrides.questions as object),
  }
  const reports = { create: vi.fn(async (..._args: unknown[]) => undefined), ...(overrides.reports as object) }
  const products = {
    findBySlugOrId: vi.fn(async (slug: string) => ({ id: 'p1', slug })),
    updateRatingSummary: vi.fn(async (..._args: unknown[]) => undefined),
    ...(overrides.products as object),
  }
  const service = new FeedbackService(reviews as never, questions as never, reports as never, products as never)
  return { service, reviews, questions, reports, products }
}

const author = { id: 'user-1', name: 'Ana', avatar: '' }

describe('feedback list', () => {
  it('returns both pagination shapes used by lumia2.0 and Lumia', async () => {
    const { service } = fakes()
    const res = await service.list('vela', {
      reviewPage: 2, reviewLimit: 8, questionPage: 1, questionLimit: 10, reviewSort: 'recent',
    })
    expect(res.pagination.page).toBe(2)
    expect(res.pagination.pages).toBe(3)
    expect(res.pagination.total).toBe(21)
    expect(res.pagination.reviews).toEqual({ page: 2, limit: 8, total: 21, pages: 3 })
    expect(res.pagination.questions).toEqual({ page: 1, limit: 10, total: 4, pages: 1 })
    expect(res.rating.average).toBe(4.5)
    expect(res.questions).toEqual([])
  })

  it('throws not found for an unknown product', async () => {
    const { service } = fakes({ products: { findBySlugOrId: vi.fn(async () => null) } })
    const err = await service
      .list('nope', { reviewPage: 1, reviewLimit: 8, questionPage: 1, questionLimit: 10 })
      .catch((e: unknown) => e)
    expect(isAppError(err)).toBe(true)
  })
})

describe('review submission', () => {
  it('marks the review verified only when a paid order exists and refreshes the product rating', async () => {
    const { service, reviews, products } = fakes()
    await service.submitReview('vela', author, { stars: 5, body: 'Muy buena' })
    expect(reviews.hasPaidOrder).toHaveBeenCalledWith('user-1', 'vela')
    expect(reviews.upsert.mock.calls[0][3]).toBe(true)
    expect(products.updateRatingSummary).toHaveBeenCalledWith('vela', 4, 7)
  })

  it('clamps stars and strips HTML from free text', async () => {
    const { service, reviews } = fakes()
    await service.submitReview('vela', author, { stars: 9, title: '<b>Hola</b>', body: '<script>x</script> bien' })
    const data = reviews.upsert.mock.calls[0][2] as { stars: number; title: string; body: string }
    expect(data.stars).toBe(5)
    expect(data.title).toBe('Hola')
    expect(data.body).toBe('x bien')
  })

  it('reports not found when reacting to a missing or hidden review', async () => {
    const { service } = fakes({ reviews: { react: vi.fn(async () => false) } })
    await expect(service.reactToReview('vela', 'bad', 'user-1', 'helpful')).rejects.toThrow(/no encontrada/)
  })
})

describe('questions and answers', () => {
  it('passes the official flag through and fails when the question is missing', async () => {
    const { service, questions } = fakes()
    await service.answerQuestion('vela', 'q1', author, 'Respuesta', true)
    expect(questions.createAnswer.mock.calls[0][3]).toBe(true)

    const missing = fakes({ questions: { createAnswer: vi.fn(async () => null) } }).service
    await expect(missing.answerQuestion('vela', 'x', author, 'Respuesta', false)).rejects.toThrow(/no encontrada/)
  })
})

describe('reports', () => {
  it('stores a sanitized report tied to the reporting user', async () => {
    const { service, reports } = fakes()
    await service.report('user-2', { entityType: 'review', entityId: 'r1', reason: '<i>spam</i>   ofensivo' })
    expect(reports.create).toHaveBeenCalledWith({
      entityType: 'review',
      entityId: 'r1',
      userId: 'user-2',
      reason: 'spam ofensivo',
    })
  })
})

describe('moderation', () => {
  it('recalculates the product rating when a review is hidden', async () => {
    const { service, reviews, products } = fakes({
      reviews: { findById: vi.fn(async () => ({ product_slug: 'vela' })) },
    })
    const admin = new AdminFeedbackService(reviews as never, { listAdmin: vi.fn() } as never, service)
    await admin.patchReview('r1', { hidden: true })
    expect(reviews.adminPatch).toHaveBeenCalledWith('r1', { hidden: true })
    expect(products.updateRatingSummary).toHaveBeenCalledWith('vela', 4, 7)
  })
})

describe('review upsert keeps moderation and votes', () => {
  it('never writes hidden, helpful counts or created_at on update', async () => {
    const updateOne = vi.fn(async () => ({}))
    const db = { collection: () => ({ updateOne }) } as never
    const repo = new ReviewRepository(db)
    await repo.upsert('vela', { id: 'u1', name: 'Ana', avatar: '' }, { stars: 4, body: 'ok' }, true)
    const update = (updateOne.mock.calls[0] as unknown as [unknown, { $set: Record<string, unknown>; $setOnInsert: Record<string, unknown> }])[1]
    expect(Object.keys(update.$set)).not.toEqual(expect.arrayContaining(['hidden', 'helpful_count', 'created_at']))
    expect(update.$setOnInsert).toHaveProperty('hidden', false)
    expect(update.$setOnInsert).toHaveProperty('created_at')
  })
})

describe('feedback schemas', () => {
  it('keeps Lumia rules: review body optional, question body at least 5 characters', () => {
    expect(reviewWriteSchema.safeParse({ stars: 4 }).success).toBe(true)
    expect(reviewWriteSchema.safeParse({ stars: 6 }).success).toBe(false)
    expect(questionWriteSchema.safeParse({ body: 'hola' }).success).toBe(false)
    expect(questionWriteSchema.safeParse({ body: 'hola!' }).success).toBe(true)
  })

  it('sanitizes text by removing tags and collapsing spaces', () => {
    expect(sanitizeFeedbackText('  <p>Hola</p>   mundo ')).toBe('Hola mundo')
  })
})

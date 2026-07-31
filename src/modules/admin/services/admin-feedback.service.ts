import { AppError } from '../../../common/errors/app.error.js'
import { buildPaginationMeta, resolvePagingQuery } from '../../../common/utils/pagination.js'
import type { ReviewRepository } from '../../sales/infrastructure/review.repository.js'
import type { FeedbackReportRepository } from '../../sales/infrastructure/feedback-report.repository.js'

export class AdminFeedbackService {
  constructor(
    private readonly reviews: ReviewRepository,
    private readonly reports: FeedbackReportRepository,
  ) {}

  async listReports(query: Record<string, unknown>) {
    const { page, limit, skip } = resolvePagingQuery(query, { defaultLimit: 20, maxLimit: 100 })
    const { items, total } = await this.reports.listAdmin(skip, limit)
    return { items, pagination: buildPaginationMeta(total, page, limit) }
  }

  async patchReview(id: string, patch: { hidden?: boolean; featured?: boolean }) {
    const ok = await this.reviews.adminPatch(id, patch)
    if (!ok) throw AppError.notFound('Reseña no encontrada')
    return { ok: true }
  }

  async patchQuestion(id: string, patch: { hidden?: boolean; answered?: boolean }) {
    const ok = await this.reports.patchQuestion(id, patch)
    if (!ok) throw AppError.notFound('Pregunta no encontrada')
    return { ok: true }
  }
}

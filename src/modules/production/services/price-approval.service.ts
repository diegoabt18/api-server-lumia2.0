import { ObjectId } from 'mongodb'
import { AppError } from '../../../common/errors/app.error.js'
import { resolvePagingQuery } from '../../../common/utils/pagination.js'
import {
  approvePriceApprovalPatch,
  publishPriceApprovalPatch,
  rejectPriceApprovalPatch,
} from '../domain/price-approval.entity.js'
import type { ApprovalStatus } from '../domain/price-approval.entity.js'
import type { PriceApprovalRepository } from '../infrastructure/price-approval.repository.js'
import type { ProductionAuditRepository } from '../infrastructure/production-audit.repository.js'
import type { ProductRepository } from '../../catalog/infrastructure/product.repository.js'

export class PriceApprovalService {
  constructor(
    private readonly approvals: PriceApprovalRepository,
    private readonly audit: ProductionAuditRepository,
    private readonly products: ProductRepository,
  ) {}

  async list(query: Record<string, unknown>) {
    const { page, limit, skip } = resolvePagingQuery(query, { defaultLimit: 20, maxLimit: 100 })
    const status = typeof query.status === 'string' ? (query.status as ApprovalStatus) : undefined
    const result = await this.approvals.list({ status, limit, offset: skip })
    return {
      data: result.items,
      meta: {
        total: result.total,
        page,
        pageSize: limit,
        totalPages: Math.ceil(result.total / limit) || 1,
      },
    }
  }

  async summary() {
    const [pending, approved, rejected, published] = await Promise.all([
      this.approvals.countByStatus('pending'),
      this.approvals.countByStatus('approved'),
      this.approvals.countByStatus('rejected'),
      this.approvals.countByStatus('published'),
    ])
    return {
      data: { pending, approved, rejected, published, total: pending + approved + rejected + published },
    }
  }

  async approve(approvalIds: string[], userId: string) {
    const results = []
    for (const id of approvalIds) {
      const approval = await this.approvals.getById(id)
      if (!approval) throw AppError.notFound(`Solicitud "${id}" no encontrada`)
      if (approval.status !== 'pending') {
        throw AppError.badRequest(`No se puede aprobar una solicitud en estado "${approval.status}"`)
      }
      const updated = await this.approvals.update(id, approvePriceApprovalPatch(userId))
      if (updated) {
        results.push(updated)
        await this.audit.insert({
          event_type: 'price_approved',
          entity_type: 'approval',
          entity_id: id,
          description: `Precio aprobado para variante ${approval.variantSku}`,
          metadata: { variantSku: approval.variantSku, suggestedPrice: approval.suggestedPrice },
          performed_by: ObjectId.isValid(userId) ? new ObjectId(userId) : userId,
          created_at: new Date(),
        })
      }
    }
    return { data: results }
  }

  async reject(approvalIds: string[], reason: string, userId: string) {
    const results = []
    for (const id of approvalIds) {
      const approval = await this.approvals.getById(id)
      if (!approval) throw AppError.notFound(`Solicitud "${id}" no encontrada`)
      if (approval.status !== 'pending') {
        throw AppError.badRequest(`No se puede rechazar una solicitud en estado "${approval.status}"`)
      }
      const updated = await this.approvals.update(id, rejectPriceApprovalPatch(userId, reason))
      if (updated) {
        results.push(updated)
        await this.audit.insert({
          event_type: 'price_rejected',
          entity_type: 'approval',
          entity_id: id,
          description: `Precio rechazado para variante ${approval.variantSku}`,
          metadata: { variantSku: approval.variantSku, reason },
          performed_by: ObjectId.isValid(userId) ? new ObjectId(userId) : userId,
          created_at: new Date(),
        })
      }
    }
    return { data: results }
  }

  async publish(approvalIds: string[], userId: string) {
    const results = []
    for (const id of approvalIds) {
      const approval = await this.approvals.getById(id)
      if (!approval) throw AppError.notFound(`Solicitud "${id}" no encontrada`)
      if (approval.status !== 'approved') {
        throw AppError.badRequest(`No se puede publicar una solicitud en estado "${approval.status}"`)
      }
      await this.products.updateVariantPrice(approval.variantSku, approval.suggestedPrice)
      const updated = await this.approvals.update(id, publishPriceApprovalPatch(userId))
      if (updated) {
        results.push(updated)
        await this.audit.insert({
          event_type: 'price_published',
          entity_type: 'approval',
          entity_id: id,
          description: `Precio publicado para variante ${approval.variantSku}: ${approval.suggestedPrice}`,
          metadata: {
            variantSku: approval.variantSku,
            previousPrice: approval.previousPrice,
            newPrice: approval.suggestedPrice,
          },
          previous_value: approval.previousPrice,
          new_value: approval.suggestedPrice,
          performed_by: ObjectId.isValid(userId) ? new ObjectId(userId) : userId,
          created_at: new Date(),
        })
      }
    }
    return { data: results }
  }
}

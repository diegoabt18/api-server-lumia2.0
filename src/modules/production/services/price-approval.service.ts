import { ObjectId } from 'mongodb'
import { AppError } from '../../../common/errors/app.error.js'
import { resolvePagingQuery } from '../../../common/utils/pagination.js'
import {
  approvePriceApprovalPatch,
  publishPriceApprovalPatch,
  rejectPriceApprovalPatch,
} from '../domain/price-approval.entity.js'
import type { ApprovalStatus, PriceApprovalDomain } from '../domain/price-approval.entity.js'
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

  /**
   * Carga todas las solicitudes y comprueba su estado ANTES de modificar ninguna: un error en una
   * solicitud del lote no deja aplicadas las anteriores.
   */
  private async loadAll(approvalIds: string[], status: ApprovalStatus, action: string): Promise<PriceApprovalDomain[]> {
    const loaded: PriceApprovalDomain[] = []
    for (const id of [...new Set(approvalIds)]) {
      const approval = await this.approvals.getById(id)
      if (!approval) throw AppError.notFound(`Solicitud "${id}" no encontrada`)
      if (approval.status !== status) {
        throw AppError.badRequest(`No se puede ${action} una solicitud en estado "${approval.status}"`)
      }
      loaded.push(approval)
    }
    return loaded
  }

  async approve(approvalIds: string[], userId: string) {
    const results = []
    for (const approval of await this.loadAll(approvalIds, 'pending', 'aprobar')) {
      const id = approval.id
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
    for (const approval of await this.loadAll(approvalIds, 'pending', 'rechazar')) {
      const id = approval.id
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

  /**
   * Comprobaciones de publicación (todas antes de escribir):
   * - la solicitud debe tener el precio final con IVA (`priceBasis: 'tax_included'`): las anteriores
   *   guardaban el precio sin IVA y publicarlo dejaría la variante por debajo de lo calculado;
   * - el precio actual de la variante debe ser el que tenía al crear la solicitud (si alguien lo
   *   cambió, publicar lo sobrescribiría sin aviso);
   * - el IVA del producto debe seguir siendo el usado en la solicitud;
   * - el precio a publicar debe ser mayor que 0.
   */
  private async assertPublishable(approval: PriceApprovalDomain): Promise<void> {
    const label = `${approval.productName ?? approval.productSlug} (${approval.variantSku})`
    if (approval.priceBasis !== 'tax_included') {
      throw AppError.conflict(
        `${label}: la solicitud se creó con la regla anterior (precio sin IVA). Recházala y vuelve a enviar el producto a aprobación.`,
      )
    }
    if (!(approval.suggestedPrice > 0)) {
      throw AppError.conflict(`${label}: el precio sugerido no es válido.`)
    }
    const variant = await this.products.getVariantRaw(approval.productSlug, approval.variantSku)
    if (!variant) throw AppError.conflict(`${label}: la variante ya no existe.`)
    if (variant.price !== approval.previousPrice) {
      throw AppError.conflict(
        `${label}: el precio cambió (${approval.previousPrice} → ${variant.price}) desde que se creó la solicitud. Recházala y vuelve a enviar el producto.`,
      )
    }
    const product = await this.products.findBySlugOrId(approval.productSlug)
    const currentTaxRate = product?.taxRate ?? null
    if (currentTaxRate !== (approval.taxRate ?? null)) {
      throw AppError.conflict(
        `${label}: el IVA del producto cambió (${approval.taxRate ?? '—'} % → ${currentTaxRate ?? '—'} %) desde que se creó la solicitud. Vuelve a enviar el producto.`,
      )
    }
  }

  async publish(approvalIds: string[], userId: string) {
    const approvals = await this.loadAll(approvalIds, 'approved', 'publicar')
    for (const approval of approvals) await this.assertPublishable(approval)

    const results = []
    for (const approval of approvals) {
      const id = approval.id
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
            newPriceNet: approval.suggestedPriceNet,
            taxRate: approval.taxRate,
            priceBasis: approval.priceBasis,
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

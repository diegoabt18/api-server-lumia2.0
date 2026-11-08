import { includedTaxAmount } from '../domain/tax.js'
import type { FinancialEventPayload } from '../domain/financial-event.entity.js'
import { buildOrderDeliveredEventKey } from '../domain/financial-event.entity.js'
import type { OrderEntity } from '../domain/order.entity.js'
import type { FinancialOutboxRepository } from '../infrastructure/financial-outbox.repository.js'

/** Payload común de los hechos financieros de una orden (venta, pago o entrega). */
export function buildOrderFinancialPayload(order: OrderEntity, actorId: string | null): FinancialEventPayload {
  const lines = order.items.map((item) => {
    const taxRate = item.taxRate ?? null
    return {
      sku: item.variantSku ?? '',
      productId: item.productId,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      subtotal: item.subtotal,
      taxRate,
      taxAmount: includedTaxAmount(item.subtotal, taxRate),
    }
  })
  const taxRateMissing = lines.some((line) => line.taxRate === null)
  // Con todas las tasas conocidas, el IVA sale de las líneas; si no, se conserva el valor de la orden.
  const tax = taxRateMissing
    ? order.tax ?? 0
    : Math.round(lines.reduce((sum, line) => sum + (line.taxAmount ?? 0), 0) * 100) / 100
  return {
    orderId: order._id ?? '',
    receiptNumber: order.receiptNumber ?? order.orderNumber ?? '',
    channel: order.channel === 'pos' ? 'pos' : 'online',
    currency: order.currency ?? 'COP',
    subtotal: order.subtotal ?? order.total,
    discountAmount: order.discountAmount ?? 0,
    tax,
    taxRateMissing,
    total: order.total,
    paymentMethod: order.paymentMethod ?? '',
    paymentStatus: order.paymentStatus ?? '',
    customer: { userId: order.userId ?? null, posCustomerId: order.posCustomerId ?? null },
    lines,
    actorId,
    fulfillment: order.fulfillment,
  }
}

/**
 * Publica el hecho de entrega. El ingreso se reconoce al entregar (decisión contable), así que
 * este evento es el disparador para el módulo contable. Idempotente por orden.
 */
export class OrderFinancialEvents {
  constructor(private readonly outbox: FinancialOutboxRepository) {}

  async recordDelivered(order: OrderEntity, actorId: string | null, deliveredAt: Date): Promise<void> {
    if (!order._id) return
    try {
      await this.outbox.enqueue({
        eventKey: buildOrderDeliveredEventKey(order._id),
        type: 'order.delivered',
        sourceType: 'order',
        sourceId: order._id,
        occurredAt: deliveredAt,
        payload: { ...buildOrderFinancialPayload(order, actorId), deliveredAt: deliveredAt.toISOString() },
      })
    } catch (error) {
      // El estado de la orden ya cambió; un fallo aquí no debe revertirlo. Queda registrado en consola.
      console.error('[orders] no se pudo encolar el evento de entrega', { orderId: order._id, error })
    }
  }
}

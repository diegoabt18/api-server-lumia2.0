/**
 * Hechos comerciales que Lumia (contabilidad) necesitará. Son snapshots inmutables:
 * registran qué ocurrió, no cómo se contabiliza. Las reglas de reconocimiento
 * (al pagar o al entregar, IVA, costo) las decide el módulo contable.
 */
export type FinancialEventType = 'pos.sale.recorded' | 'pos.payment.confirmed' | 'order.delivered'

export type FinancialEventStatus = 'pending' | 'processing' | 'processed' | 'failed'

export interface FinancialEventLine {
  sku: string
  productId: string
  quantity: number
  unitPrice: number
  subtotal: number
  taxRate: number | null
  taxAmount: number | null
}

export interface FinancialEventPayload {
  orderId: string
  receiptNumber: string
  channel: 'pos' | 'online'
  currency: string
  subtotal: number
  discountAmount: number
  tax: number
  total: number
  paymentMethod: string
  paymentStatus: string
  customer: { userId: string | null; posCustomerId: string | null }
  lines?: FinancialEventLine[]
  cashReceived?: number | null
  changeGiven?: number | null
  transferReference?: string | null
  actorId: string | null
  /** true si alguna línea no tiene tasa de IVA configurada: el impuesto de la orden está incompleto. */
  taxRateMissing?: boolean
  /** Momento de entrega (solo en order.delivered). */
  deliveredAt?: string
  fulfillment?: string
}

export interface FinancialEventEntity {
  _id?: unknown
  /** Clave de idempotencia: un mismo hecho nunca se encola dos veces. */
  eventKey: string
  type: FinancialEventType
  sourceType: 'order'
  sourceId: string
  occurredAt: Date
  payload: FinancialEventPayload
  status: FinancialEventStatus
  attempts: number
  lastError?: string | null
  lockedUntil?: Date | null
  createdAt: Date
  processedAt?: Date | null
}

export function buildPosSaleEventKey(orderId: string): string {
  return `pos.sale.recorded:${orderId}`
}

export function buildOrderDeliveredEventKey(orderId: string): string {
  return `order.delivered:${orderId}`
}

export function buildPosPaymentEventKey(orderId: string): string {
  return `pos.payment.confirmed:${orderId}`
}

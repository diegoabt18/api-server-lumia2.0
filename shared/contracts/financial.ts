/**
 * Contrato de eventos financieros (sales_db.financial_outbox). Son hechos comerciales,
 * no asientos contables: el módulo contable decide cómo reconocerlos.
 */

export type FinancialEventType = 'pos.sale.recorded' | 'pos.payment.confirmed' | 'order.delivered'

export interface FinancialEventLineContract {
  sku: string
  productId: string
  quantity: number
  unitPrice: number
  subtotal: number
  taxRate: number | null
  taxAmount: number | null
}

export interface FinancialEventPayloadContract {
  orderId: string
  receiptNumber: string
  channel: 'pos' | 'online'
  currency: string
  subtotal: number
  discountAmount: number
  tax: number
  /** true si alguna línea no tiene tasa de IVA configurada. */
  taxRateMissing?: boolean
  total: number
  paymentMethod: string
  paymentStatus: string
  customer: { userId: string | null; posCustomerId: string | null }
  lines?: FinancialEventLineContract[]
  cashReceived?: number | null
  changeGiven?: number | null
  transferReference?: string | null
  actorId: string | null
  deliveredAt?: string
  fulfillment?: string
}

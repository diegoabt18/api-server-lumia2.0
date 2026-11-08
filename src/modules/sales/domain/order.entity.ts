export type OrderStatus = 'pending' | 'paid' | 'shipped' | 'delivered' | 'cancelled' | 'expired'
export type OrderPaymentStatus =
  | 'unpaid'
  | 'pending'
  | 'in_process'
  | 'pending_manual'
  | 'paid'
  | 'refunded'
  | 'failed'
  | 'expired'
  | 'deposit_pending'
  | 'deposit_paid'
  | 'final_payment_pending'
  | 'payment_completed'

export type CancelledBy = 'customer' | 'admin' | 'system'
export type CancellationRequestStatus = 'requested' | 'approved' | 'rejected' | 'info_needed'
export type OrderChannel = 'online' | 'pos'
export type OrderFulfillment = 'delivery' | 'in_store'
export type PosPaymentState = 'pending_manual' | 'paid'

export interface OrderEvent {
  type: string
  timestamp: Date
  source: 'system' | 'user' | 'admin' | 'provider'
  actorId?: string
  data?: Record<string, unknown>
}

export interface OrderItemEntity {
  productId: string
  /** Tasa de IVA (%) vigente al vender; congelada en la línea. null = no configurada. */
  taxRate?: number | null
  productSlug?: string
  variantSku?: string
  variantName?: string
  name: string
  quantity: number
  unitPrice: number
  subtotal: number
  selectionLabel?: string
  selectedOptions?: Array<{ label: string; value: string }>
  imageUrl?: string
  /** Precio de catálogo antes de promoción (solo POS). */
  originalUnitPrice?: number
  promotionPercentOff?: number
  promotionId?: string
}

export interface OrderEntity {
  _id?: string
  orderNumber?: string
  userId: string | null
  email: string | null
  customerName: string
  phone: string
  whatsapp?: string
  address: string
  city: string
  reference: string
  notes?: string
  items: OrderItemEntity[]
  subtotal?: number
  shippingCost?: number
  tax?: number
  discountAmount?: number
  total: number
  status: OrderStatus
  paymentStatus?: OrderPaymentStatus
  fulfillmentStatus?: string
  /** Canal comercial. Ausente = online (compatibilidad con pedidos existentes). */
  channel?: OrderChannel
  /** Cliente de mostrador (pos_customers) cuando la venta no tiene cuenta web. */
  posCustomerId?: string | null
  /** Stock descontado para esta orden (al pagarse o al venderse en POS). */
  stockDecrementedAt?: Date | null
  /** Stock devuelto tras cancelar una orden cuyo stock se había descontado. */
  stockRestoredAt?: Date | null
  /** Modalidad de entrega. Ausente = delivery (compatibilidad). */
  fulfillment?: OrderFulfillment
  /** Administrador que registró una venta POS. */
  createdByUserId?: string | null
  /** Consecutivo interno del comprobante POS. */
  receiptNumber?: string
  /** Clave de idempotencia del POS (única cuando está presente). */
  idempotencyKey?: string
  currency?: string
  paymentMethod?: string
  paidAt?: Date | null
  cashReceived?: number | null
  changeGiven?: number | null
  transferReference?: string | null
  paymentConfirmedByUserId?: string | null
  paymentConfirmedAt?: Date | null
  deliveredAt?: Date | null
  depositPercentage?: number
  depositAmount?: number
  depositPaidAt?: Date | null
  finalPaymentAmount?: number
  finalPaymentPaidAt?: Date | null
  createdAt: Date
  updatedAt?: Date
  cancelledAt?: Date
  cancelledBy?: CancelledBy
  cancellationReason?: string
  cancellationRequested?: boolean
  cancellationRequestedAt?: Date
  cancellationRequestReason?: string
  cancellationRequestStatus?: CancellationRequestStatus
  events?: OrderEvent[]
}

export interface OrderDomain {
  id: string
  orderNumber?: string
  userId: string | null
  email: string | null
  customerName: string
  phone: string
  whatsapp?: string
  address: string
  city: string
  reference: string
  notes?: string
  items: OrderItemEntity[]
  subtotal?: number
  shippingCost?: number
  total: number
  status: OrderStatus
  paymentStatus?: OrderPaymentStatus
  fulfillmentStatus?: string
  channel?: OrderChannel
  fulfillment?: OrderFulfillment
  createdByUserId?: string | null
  receiptNumber?: string
  currency?: string
  createdAt: string
  cancellationRequested?: boolean
  cancellationRequestStatus?: CancellationRequestStatus
}

export function toOrderDomain(e: OrderEntity): OrderDomain {
  return {
    id: e._id!,
    orderNumber: e.orderNumber,
    userId: e.userId,
    email: e.email,
    customerName: e.customerName,
    phone: e.phone,
    whatsapp: e.whatsapp,
    address: e.address,
    city: e.city,
    reference: e.reference,
    notes: e.notes,
    items: e.items,
    subtotal: e.subtotal,
    shippingCost: e.shippingCost,
    total: e.total,
    status: e.status,
    paymentStatus: e.paymentStatus,
    currency: e.currency ?? 'COP',
    channel: e.channel,
    fulfillment: e.fulfillment,
    createdByUserId: e.createdByUserId,
    receiptNumber: e.receiptNumber,
    createdAt: e.createdAt.toISOString(),
    cancellationRequested: e.cancellationRequested,
    cancellationRequestStatus: e.cancellationRequestStatus,
  }
}

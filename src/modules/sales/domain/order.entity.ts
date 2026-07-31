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

export interface OrderEvent {
  type: string
  timestamp: Date
  source: 'system' | 'user' | 'admin' | 'provider'
  actorId?: string
  data?: Record<string, unknown>
}

export interface OrderItemEntity {
  productId: string
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
  currency?: string
  paymentMethod?: string
  paidAt?: Date | null
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
    createdAt: e.createdAt.toISOString(),
    cancellationRequested: e.cancellationRequested,
    cancellationRequestStatus: e.cancellationRequestStatus,
  }
}

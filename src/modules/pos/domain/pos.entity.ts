import { nextRequiredPayment } from '../../sales/domain/order-payment-ledger.js'
import type {
  OrderChannel,
  OrderEntity,
  OrderFulfillment,
  OrderItemEntity,
  PosPaymentState,
} from '../../sales/domain/order.entity.js'

export type PosCustomerMode = 'existing' | 'walk_in'

export interface PosActor {
  userId: string
  email?: string | null
}

export interface PosCustomerInput {
  mode: PosCustomerMode
  userId?: string | null
  /** Cliente de mostrador ya registrado (identity_db.pos_customers). */
  posCustomerId?: string | null
  name?: string
  phone?: string
  email?: string | null
}

export interface PosSaleInput {
  customer: PosCustomerInput
  items: Array<{ sku: string; quantity: number }>
  payment: {
    method: string
    state: PosPaymentState
  }
  discountAmount?: number
  notes?: string
}

export interface PosSaleLine {
  sku: string
  quantity: number
  productId: string
  taxRate?: number | null
  productSlug: string
  name: string
  variantLabel?: string
  imageUrl?: string | null
  unitPrice: number
  originalUnitPrice: number
  subtotal: number
  currency: string
  promotionPercentOff?: number
  promotionId?: string
  tracked: boolean
  isPerOrder: boolean
}

export interface PosPaymentEventView {
  type: string
  timestamp: string
  actorId?: string | null
  data?: Record<string, unknown>
}

export interface PosSaleView {
  id: string
  orderNumber: string
  receiptNumber: string
  channel: OrderChannel
  fulfillment: OrderFulfillment
  status: string
  paymentStatus: string
  fulfillmentStatus: string
  paymentMethod: string
  /** Pago inicial, pagado y saldo (G3). */
  initialPaymentRequired?: number
  paidAmount?: number
  balanceDue?: number
  /** Importe exacto que debe cobrarse ahora (anticipo pendiente o saldo completo). */
  nextPaymentRequired?: number
  cashReceived?: number | null
  changeGiven?: number | null
  transferReference?: string | null
  paymentConfirmedByUserId?: string | null
  paymentConfirmedAt?: string | null
  paymentEvents: PosPaymentEventView[]
  customerName: string
  phone: string
  email: string | null
  subtotal: number
  discountAmount: number
  tax: number
  total: number
  currency: string
  createdAt: string
  items: OrderItemEntity[]
}

export interface PosSaleResult {
  order: PosSaleView
  receiptUrl: string
  replayed: boolean
}

export interface PosProductVariantView {
  sku: string
  label: string
  barcode: string | null
  price: number
  originalPrice: number
  promotionPercentOff?: number
  currency: string
  stock: number
  available: number
  tracked: boolean
  isPerOrder: boolean
}

export interface PosProductView {
  id: string
  slug: string
  name: string
  imagePath: string | null
  variants: PosProductVariantView[]
}

export interface PosPaymentMethodView {
  methodId: string
  displayName: string
  description: string
  supportsPaid: boolean
}

export interface PosBankTransferDetails {
  bankName: string
  accountNumber: string
  accountHolder: string
  taxId?: string
  instructions?: string
}

export interface PosPaymentConfig {
  methods: PosPaymentMethodView[]
  bankTransferDetails: PosBankTransferDetails | null
}

export interface PosCustomerView {
  id: string
  name: string
  email: string | null
  phone: string | null
  /** 'account' = cuenta web; 'counter' = cliente de mostrador. */
  source: 'account' | 'counter'
}

function toPaymentEvents(order: OrderEntity): PosPaymentEventView[] {
  return (order.events ?? [])
    .filter((event) => event.type.startsWith('payment.'))
    .map((event) => ({
      type: event.type,
      timestamp:
        event.timestamp instanceof Date ? event.timestamp.toISOString() : String(event.timestamp),
      actorId: event.actorId ?? null,
      data: event.data,
    }))
}

export function toPosSaleView(order: OrderEntity): PosSaleView {
  return {
    id: order._id ?? '',
    orderNumber: order.orderNumber ?? order.receiptNumber ?? '',
    receiptNumber: order.receiptNumber ?? order.orderNumber ?? '',
    channel: order.channel ?? 'pos',
    fulfillment: order.fulfillment ?? 'in_store',
    status: order.status,
    paymentStatus: order.paymentStatus ?? 'unpaid',
    fulfillmentStatus: order.fulfillmentStatus ?? 'unfulfilled',
    paymentMethod: order.paymentMethod ?? 'manual',
    initialPaymentRequired: order.initialPaymentRequired ?? order.total,
    paidAmount: order.paidAmount ?? (order.paymentStatus === 'paid' ? order.total : 0),
    balanceDue: order.balanceDue ?? (order.paymentStatus === 'paid' ? 0 : order.total),
    nextPaymentRequired: nextRequiredPayment({
      balanceDue: order.balanceDue ?? (order.paymentStatus === 'paid' ? 0 : order.total),
      initialRemaining: Math.max(0, (order.initialPaymentRequired ?? order.total) - (order.paidAmount ?? (order.paymentStatus === 'paid' ? order.total : 0))),
    }),
    cashReceived: order.cashReceived ?? null,
    changeGiven: order.changeGiven ?? null,
    transferReference: order.transferReference ?? null,
    paymentConfirmedByUserId: order.paymentConfirmedByUserId ?? null,
    paymentConfirmedAt:
      order.paymentConfirmedAt instanceof Date ? order.paymentConfirmedAt.toISOString() : (order.paymentConfirmedAt ? String(order.paymentConfirmedAt) : null),
    paymentEvents: toPaymentEvents(order),
    customerName: order.customerName,
    phone: order.phone,
    email: order.email ?? null,
    subtotal: order.subtotal ?? order.total,
    discountAmount: order.discountAmount ?? 0,
    tax: order.tax ?? 0,
    total: order.total,
    currency: order.currency ?? 'COP',
    createdAt:
      order.createdAt instanceof Date ? order.createdAt.toISOString() : String(order.createdAt),
    items: order.items,
  }
}

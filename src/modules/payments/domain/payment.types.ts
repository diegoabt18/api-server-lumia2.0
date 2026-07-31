export type PaymentMethod = 'manual' | 'mercadopago'

export type PaymentStatus =
  | 'created'
  | 'pending'
  | 'in_process'
  | 'approved'
  | 'rejected'
  | 'cancelled'
  | 'refunded'
  | 'charged_back'
  | 'in_mediation'

export interface PaymentEvent {
  type: string
  timestamp: Date
  source: 'system' | 'user' | 'admin' | 'provider'
  data?: Record<string, unknown>
}

export interface PaymentEntity {
  _id?: string
  orderId: string
  attemptNumber: number
  status: PaymentStatus
  statusDetail?: string
  paymentMethod: PaymentMethod
  providerPreferenceId?: string
  providerPaymentId?: string
  externalReference: string
  amount: number
  currency: string
  refundedAmount: number
  createdAt: Date
  updatedAt: Date
  paidAt?: Date
  events: PaymentEvent[]
}

export function createPaymentEntity(input: {
  orderId: string
  attemptNumber: number
  externalReference: string
  amount: number
  currency: string
  paymentMethod: PaymentMethod
  providerPreferenceId?: string
  status?: PaymentStatus
}): PaymentEntity {
  const now = new Date()
  return {
    orderId: input.orderId,
    attemptNumber: input.attemptNumber,
    status: input.status ?? 'created',
    paymentMethod: input.paymentMethod,
    externalReference: input.externalReference,
    amount: input.amount,
    currency: input.currency,
    refundedAmount: 0,
    providerPreferenceId: input.providerPreferenceId,
    createdAt: now,
    updatedAt: now,
    events: [
      {
        type: 'payment.created',
        timestamp: now,
        source: 'system',
        data: { attemptNumber: input.attemptNumber, method: input.paymentMethod },
      },
    ],
  }
}

export function createPaymentEvent(
  type: string,
  source: PaymentEvent['source'],
  data?: Record<string, unknown>,
): PaymentEvent {
  return { type, timestamp: new Date(), source, data }
}

import type { PaymentStatus } from '../../payments/domain/payment.types.js'

/**
 * Single mapping between the order payment status used by POS/admin screens
 * (`pending_manual` | `paid`) and the payment entity status (`pending` | `approved`).
 * Keep every POS write path on these helpers so the two vocabularies cannot drift.
 */
export type PosOrderPaymentStatus = 'pending_manual' | 'paid'

export function paymentStatusForPosSale(paid: boolean): PaymentStatus {
  return paid ? 'approved' : 'pending'
}

export function orderPaymentStatusForPayment(status: PaymentStatus): PosOrderPaymentStatus {
  return status === 'approved' ? 'paid' : 'pending_manual'
}

/** Payment status applied when an administrator confirms a manual POS payment. */
export const POS_CONFIRMED_PAYMENT_STATUS: PaymentStatus = 'approved'

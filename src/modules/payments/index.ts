/**
 * Payments module — Fase 2 (pago manual).
 *
 * @see docs/modules/payments.md
 * @see docs/roadmap.md#fase-2--checkout-y-pagos
 */
export type { PaymentEntity, PaymentMethod, PaymentStatus } from './domain/payment.types.js'
export { ManualPaymentService } from './services/manual-payment.service.js'
export { PaymentRepository } from './infrastructure/payment.repository.js'

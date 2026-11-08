/** Contrato de pagos en línea (Mercado Pago y manual). */

export interface PaymentMethodOptionContract {
  id: string
  displayName: string
  description: string
  isActive: true
  requiresRedirect: boolean
  isEmbedded: false
  estimatedProcessingTime: string
}

export interface PaymentPreferenceContract {
  paymentId: string
  providerPreferenceId: string
  initPoint?: string
  sandboxInitPoint?: string
  orderId: string
  orderNumber?: string
}

export interface ManualPaymentContract {
  paymentId: string
  orderId: string
  orderNumber?: string
  instructions: string
  paymentStatus: 'pending_manual'
}

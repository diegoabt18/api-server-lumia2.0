export type PaymentMethod = 'mercadopago' | 'manual'

export interface PaymentMethodInfo {
  id: PaymentMethod
  displayName: string
  description: string
  icon?: string
  requiresRedirect: boolean
  estimatedProcessingTime: string
}

export const AVAILABLE_PAYMENT_METHODS: PaymentMethodInfo[] = [
  {
    id: 'mercadopago',
    displayName: 'Mercado Pago',
    description: 'Paga con tarjeta, efectivo o transferencia bancaria',
    requiresRedirect: true,
    estimatedProcessingTime: 'Inmediato',
  },
  {
    id: 'manual',
    displayName: 'Pago acordado con el vendedor',
    description: 'Coordinamos el pago por WhatsApp, transferencia o contra entrega',
    requiresRedirect: false,
    estimatedProcessingTime: 'Según acuerdo',
  },
]

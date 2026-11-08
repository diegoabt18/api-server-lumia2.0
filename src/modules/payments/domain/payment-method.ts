export type PaymentMethod = 'mercadopago' | 'manual' | 'cash' | 'bank_transfer'

export interface PaymentMethodInfo {
  id: PaymentMethod
  displayName: string
  description: string
  icon?: string
  requiresRedirect: boolean
  estimatedProcessingTime: string
}

/** Stored display metadata for a method (from `store_payment_settings`); all fields optional. */
export interface PaymentMethodDisplayOverride {
  displayName?: string
  description?: string
  estimatedProcessingTime?: string
}

/**
 * Resolves the presentation text of a method. Values stored in the database win; the entries
 * in AVAILABLE_PAYMENT_METHODS are only a fallback for methods whose metadata was never stored.
 */
export function resolvePaymentMethodDisplay(
  method: PaymentMethod,
  stored?: PaymentMethodDisplayOverride,
): { displayName: string; description: string; estimatedProcessingTime: string; requiresRedirect: boolean } {
  const fallback = AVAILABLE_PAYMENT_METHODS.find((item) => item.id === method)
  return {
    displayName: stored?.displayName?.trim() || fallback?.displayName || method,
    description: stored?.description?.trim() || fallback?.description || '',
    estimatedProcessingTime: stored?.estimatedProcessingTime?.trim() || fallback?.estimatedProcessingTime || '',
    requiresRedirect: fallback?.requiresRedirect ?? false,
  }
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
  {
    id: 'cash',
    displayName: 'Efectivo',
    description: 'Pago en efectivo en caja. Registra el importe recibido y el cambio.',
    requiresRedirect: false,
    estimatedProcessingTime: 'Inmediato',
  },
  {
    id: 'bank_transfer',
    displayName: 'Transferencia bancaria',
    description: 'Transferencia a la cuenta bancaria del establecimiento. Requiere verificación manual.',
    requiresRedirect: false,
    estimatedProcessingTime: 'Según verificación',
  },
]

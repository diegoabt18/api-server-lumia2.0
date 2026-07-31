export type CalculationType = 'flat_rate' | string
export type ThresholdApplication = 'subtotal' | 'total_before_taxes' | 'total_final'

export interface ShippingMessages {
  remainingMessage: string
  freeShippingMessage: string
  shippingCostMessage: string
  variableShippingMessage: string
  progressBarMessage: string
  progressBarCompleteMessage: string
}

export interface ShippingConfig {
  shippingEnabled: boolean
  freeShippingEnabled: boolean
  freeShippingThreshold: number
  calculationType: CalculationType
  flatRateEnabled: boolean
  flatRate: number
  applyThresholdOn: ThresholdApplication
  showProgressBar: boolean
  showMessages: boolean
  messages: ShippingMessages
}

export const DEFAULT_SHIPPING_MESSAGES: ShippingMessages = {
  remainingMessage: 'Te faltan {remaining} para obtener envío gratis.',
  freeShippingMessage: '¡Felicitaciones! Tu pedido tiene envío gratis.',
  shippingCostMessage: 'El envío tiene un costo de {shippingCost}.',
  variableShippingMessage: 'El costo del envío correrá por parte del cliente y dependerá de la transportadora.',
  progressBarMessage: 'Te faltan {remaining} para envío gratis.',
  progressBarCompleteMessage: '¡Envío gratis!',
}

export const DEFAULT_SHIPPING_CONFIG: ShippingConfig = {
  shippingEnabled: true,
  freeShippingEnabled: true,
  freeShippingThreshold: 150000,
  calculationType: 'flat_rate',
  flatRateEnabled: true,
  flatRate: 12000,
  applyThresholdOn: 'subtotal',
  showProgressBar: true,
  showMessages: true,
  messages: { ...DEFAULT_SHIPPING_MESSAGES },
}

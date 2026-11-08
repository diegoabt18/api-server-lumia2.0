import { AppError } from '../../../common/errors/app.error.js'

export const MERCADOPAGO_DISABLED_CODE = 'MERCADOPAGO_DISABLED'

/**
 * Mercado Pago está apagado salvo que MERCADOPAGO_ENABLED=true. Tener credenciales configuradas
 * NO activa la integración: la activación es una decisión explícita y separada.
 */
export function isMercadoPagoEnabled(env: { MERCADOPAGO_ENABLED: boolean; MP_ACCESS_TOKEN?: string }): boolean {
  return env.MERCADOPAGO_ENABLED === true && Boolean(env.MP_ACCESS_TOKEN)
}

/** Lanza 503 antes de tocar cualquier operación de cobro cuando la integración está apagada. */
export function assertMercadoPagoEnabled(enabled: boolean): void {
  if (!enabled) {
    throw new AppError(503, 'Mercado Pago está desactivado en este entorno', MERCADOPAGO_DISABLED_CODE)
  }
}

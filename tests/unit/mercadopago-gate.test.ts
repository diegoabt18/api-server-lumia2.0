import { describe, it, expect } from 'vitest'
import {
  MERCADOPAGO_DISABLED_CODE,
  assertMercadoPagoEnabled,
  isMercadoPagoEnabled,
} from '../../src/modules/payments/domain/mercadopago-gate.js'
import { OnlinePaymentService } from '../../src/modules/payments/services/online-payment.service.js'
import { loadEnv } from '../../src/config/env.js'
import { isAppError } from '../../src/common/errors/app.error.js'

describe('Mercado Pago kill switch', () => {
  it('stays disabled by default and credentials alone never enable it', () => {
    expect(isMercadoPagoEnabled({ MERCADOPAGO_ENABLED: false, MP_ACCESS_TOKEN: 'APP_USR-token' })).toBe(false)
    expect(isMercadoPagoEnabled({ MERCADOPAGO_ENABLED: false })).toBe(false)
  })

  it('requires both the explicit flag and a token', () => {
    expect(isMercadoPagoEnabled({ MERCADOPAGO_ENABLED: true })).toBe(false)
    expect(isMercadoPagoEnabled({ MERCADOPAGO_ENABLED: true, MP_ACCESS_TOKEN: 'APP_USR-token' })).toBe(true)
  })

  it('rejects operations with 503 and a stable code while disabled', () => {
    let caught: unknown
    try {
      assertMercadoPagoEnabled(false)
    } catch (e) {
      caught = e
    }
    expect(isAppError(caught)).toBe(true)
    expect((caught as { statusCode: number }).statusCode).toBe(503)
    expect((caught as { code?: string }).code).toBe(MERCADOPAGO_DISABLED_CODE)
    expect(() => assertMercadoPagoEnabled(true)).not.toThrow()
  })

  it('parses MERCADOPAGO_ENABLED from the environment as a boolean, defaulting to false', () => {
    const base = {
      MONGO_AUTH_URI: 'mongodb://127.0.0.1:27017/identity_db',
      MONGO_CATALOG_URI: 'mongodb://127.0.0.1:27017/catalog_db',
      MONGO_SALES_URI: 'mongodb://127.0.0.1:27017/sales_db',
      MONGO_PRODUCTION_URI: 'mongodb://127.0.0.1:27017/production_db',
      JWT_SECRET: 'test-secret-with-enough-length-0123456789',
    }
    expect(loadEnv({ ...base, MERCADOPAGO_ENABLED: 'true' }).MERCADOPAGO_ENABLED).toBe(true)
    expect(loadEnv({ ...base, MERCADOPAGO_ENABLED: 'false' }).MERCADOPAGO_ENABLED).toBe(false)
    expect(loadEnv({ ...base, MP_ACCESS_TOKEN: 'APP_USR-token' }).MERCADOPAGO_ENABLED).toBe(false)
  })

  it('the payment service refuses to create a preference without a client, before touching the order', async () => {
    // Sin repositorios: si la comprobación fuera posterior, fallaría con otro error.
    const service = new OnlinePaymentService(
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null,
      { frontendUrl: 'https://example.test', notificationUrl: 'https://example.test/webhook' },
    )
    const err = await service.createPreference('order-1').catch((e: unknown) => e)
    expect(isAppError(err)).toBe(true)
    expect((err as { statusCode: number }).statusCode).toBe(503)
    expect((err as { code?: string }).code).toBe(MERCADOPAGO_DISABLED_CODE)
  })
})

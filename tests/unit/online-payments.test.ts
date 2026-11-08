import { describe, it, expect, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import {
  createMercadoPagoClient,
  MercadoPagoApiError,
  parseMercadoPagoWebhook,
  verifyMercadoPagoSignature,
} from '../../src/modules/payments/infrastructure/mercadopago.client.js'
import { OnlinePaymentService } from '../../src/modules/payments/services/online-payment.service.js'

describe('Mercado Pago webhook parsing and signature', () => {
  it('extracts the payment id from a payment notification', () => {
    expect(parseMercadoPagoWebhook({ type: 'payment', data: { id: 123 } })).toEqual({ type: 'payment', paymentId: '123' })
    expect(parseMercadoPagoWebhook({ type: 'payment' })).toBeNull()
    expect(parseMercadoPagoWebhook(null)).toBeNull()
  })

  it('accepts a correct HMAC signature and rejects a tampered one', () => {
    const secret = 'whsec_test'
    const ts = '1700000000'
    const requestId = 'req-1'
    const dataId = 'abc123'
    const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`
    const v1 = createHmac('sha256', secret).update(manifest).digest('hex')
    const base = { secret, requestId, dataId }
    expect(verifyMercadoPagoSignature({ ...base, signatureHeader: `ts=${ts},v1=${v1}` })).toBe(true)
    expect(verifyMercadoPagoSignature({ ...base, signatureHeader: `ts=${ts},v1=${'0'.repeat(64)}` })).toBe(false)
    expect(verifyMercadoPagoSignature({ ...base, signatureHeader: undefined })).toBe(false)
  })
})

describe('Mercado Pago client', () => {
  it('maps unknown provider statuses to pending and keeps the external reference', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ id: 9, status: 'something_new', external_reference: 'order-1-attempt-1', transaction_amount: 100 }), { status: 200 }),
    )
    const client = createMercadoPagoClient({ accessToken: 'tok', fetchImpl })
    const res = await client.getPayment('9')
    expect(res.status).toBe('pending')
    expect(res.externalReference).toBe('order-1-attempt-1')
    expect(res.transactionAmount).toBe(100)
  })

  it('throws a status-only error without leaking the provider body', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"secret":"do-not-log"}', { status: 401 }))
    const client = createMercadoPagoClient({ accessToken: 'tok', fetchImpl })
    const err = await client.getPayment('9').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MercadoPagoApiError)
    expect((err as MercadoPagoApiError).status).toBe(401)
    expect((err as Error).message).not.toContain('do-not-log')
  })
})

type Order = {
  _id: string
  userId: string | null
  email: string | null
  orderNumber: string
  status: string
  paymentStatus: string
  total: number
  currency: string
  items: Array<{ productId: string; variantSku?: string; quantity: number }>
}

function buildOnline(opts: { order?: Partial<Order>; verification?: Record<string, unknown>; payments?: unknown[]; decrementOk?: boolean } = {}) {
  const order: Order = {
    _id: 'order-1',
    userId: 'user-1',
    email: 'a@b.co',
    orderNumber: 'LUM-1',
    status: 'pending',
    paymentStatus: 'unpaid',
    total: 100000,
    currency: 'COP',
    items: [{ productId: 'p1', variantSku: 'VELA-M', quantity: 2 }],
    ...opts.order,
  }
  const payment = {
    _id: 'pay-1',
    orderId: 'order-1',
    status: 'pending',
    externalReference: 'order-order-1-attempt-1',
    providerPreferenceId: 'pref-1',
    ...((opts.payments?.[0] as object) ?? {}),
  }
  const payments = {
    listPaymentsByOrderId: vi.fn(async () => (opts.payments ?? [payment]) as never[]),
    updatePaymentStatus: vi.fn(async () => undefined),
    addPaymentEvent: vi.fn(async () => undefined),
    savePayment: vi.fn(async () => 'pay-new'),
    findPaymentByExternalReference: vi.fn(async (ref: string) => (ref === payment.externalReference ? payment : null)),
    markApprovedByProvider: vi.fn(async () => undefined),
  }
  const orders = {
    findEntityById: vi.fn(async () => order),
    markOnlinePaid: vi.fn(async () => true),
    updatePaymentStatus: vi.fn(async () => undefined),
    claimStockDecrement: vi.fn(async () => true),
  }
  const carts = { clear: vi.fn(async () => undefined) }
  const inventory = { decrementAtomic: vi.fn(async () => opts.decrementOk ?? true) }
  const mp = {
    createPreference: vi.fn(async () => ({ providerPreferenceId: 'pref-2', initPoint: 'https://mp/init', sandboxInitPoint: 'https://mp/sb' })),
    getPayment: vi.fn(async () => ({
      providerPaymentId: '555',
      status: 'approved',
      externalReference: payment.externalReference,
      transactionAmount: 100000,
      ...(opts.verification ?? {}),
    })),
    cancelPreference: vi.fn(async () => undefined),
  }
  const manual = { createForOrder: vi.fn(async () => ({ paymentId: 'm1' })) }
  const service = new OnlinePaymentService(
    payments as never,
    orders as never,
    carts as never,
    inventory as never,
    manual as never,
    mp as never,
    { frontendUrl: 'https://tienda.test', notificationUrl: 'https://api.test/api/mercadopago/webhook' },
  )
  return { service, payments, orders, carts, inventory, mp }
}

describe('OnlinePaymentService', () => {
  it('cancels previous pending preferences and keeps the Lumia external reference format', async () => {
    const { service, payments, mp } = buildOnline({
      payments: [{ _id: 'old', status: 'pending', providerPreferenceId: 'pref-old', externalReference: 'x' }],
    })
    const res = await service.createPreference('order-1')
    expect(mp.cancelPreference).toHaveBeenCalledWith('pref-old')
    expect(payments.updatePaymentStatus).toHaveBeenCalledWith('old', 'cancelled', 'Cancelled by new preference')
    const pref = (mp.createPreference.mock.calls[0] as unknown as [{ externalReference: string; backUrls: { success: string } }])[0]
    expect(pref.externalReference).toBe('order-order-1-attempt-2')
    expect(pref.backUrls.success).toBe('https://tienda.test/thank-you/LUM-1')
    expect(res.initPoint).toBe('https://mp/init')
  })

  it('marks an approved payment as paid, decrements stock by variant SKU and clears the cart', async () => {
    const { service, orders, inventory, carts } = buildOnline()
    const outcome = await service.confirmWebhook('555')
    expect(outcome).toEqual({ status: 'approved', ignored: false })
    expect(orders.markOnlinePaid).toHaveBeenCalledTimes(1)
    expect(inventory.decrementAtomic).toHaveBeenCalledWith('VELA-M', 2)
    expect(carts.clear).toHaveBeenCalledWith('user-1')
  })

  it('does not mark the order paid when the charged amount differs from the total', async () => {
    const { service, orders, inventory, payments } = buildOnline({ verification: { transactionAmount: 1 } })
    const outcome = await service.confirmWebhook('555')
    expect(outcome.status).toBe('amount_mismatch')
    expect(orders.markOnlinePaid).not.toHaveBeenCalled()
    expect(inventory.decrementAtomic).not.toHaveBeenCalled()
    expect(payments.addPaymentEvent).toHaveBeenCalled()
  })

  it('ignores a duplicate webhook for an already-approved payment', async () => {
    const { service, orders } = buildOnline({ payments: [{ _id: 'pay-1', status: 'approved', externalReference: 'order-order-1-attempt-1', orderId: 'order-1' }] })
    const outcome = await service.confirmWebhook('555')
    expect(outcome).toEqual({ status: 'ignored', ignored: true, reason: 'already_processed' })
    expect(orders.markOnlinePaid).not.toHaveBeenCalled()
  })

  it('records a rejection without touching the order', async () => {
    const { service, orders, payments } = buildOnline({ verification: { status: 'rejected', statusDetail: 'cc_rejected' } })
    const outcome = await service.confirmWebhook('555')
    expect(outcome).toEqual({ status: 'rejected', ignored: false })
    expect(payments.updatePaymentStatus).toHaveBeenCalledWith('pay-1', 'rejected', 'cc_rejected')
    expect(orders.markOnlinePaid).not.toHaveBeenCalled()
  })

  it('keeps the order paid but records the event when stock cannot be decremented', async () => {
    const { service, orders } = buildOnline({ decrementOk: false })
    await service.confirmWebhook('555')
    expect(orders.markOnlinePaid).toHaveBeenCalled()
    expect(orders.updatePaymentStatus).toHaveBeenCalledWith(
      'order-1',
      'paid',
      expect.objectContaining({ type: 'inventory.updated' }),
    )
  })

  it('ignores notifications for unknown payments', async () => {
    const { service, orders } = buildOnline({ verification: { externalReference: 'order-unknown-attempt-1' } })
    const outcome = await service.confirmWebhook('555')
    expect(outcome).toEqual({ status: 'ignored', ignored: true, reason: 'payment_not_found' })
    expect(orders.markOnlinePaid).not.toHaveBeenCalled()
  })
})

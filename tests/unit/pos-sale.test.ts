import { describe, it, expect, vi } from 'vitest'
import { PosSaleService } from '../../src/modules/pos/services/pos-sale.service.js'
import { isAppError } from '../../src/common/errors/app.error.js'

type Variant = {
  sku: string
  product_slug: string
  price: number
  currency: string
  description?: string
  options?: Record<string, string>
  inventory?: Array<{ is_per_order?: boolean }>
}

function buildService(opts: {
  variants: Record<string, Variant>
  available?: Record<string, number>
  orderStatus?: string
}) {
  const available = opts.available ?? {}
  const createPosOrder = vi.fn(async (data: Record<string, unknown>) => ({
    _id: 'order-1',
    orderNumber: 'ORD-1',
    channel: 'pos',
    ...data,
  }))
  const decrementAtomic = vi.fn(async (sku: string, qty: number) => (available[sku] ?? 0) >= qty)

  const orders = {
    findByIdempotencyKey: vi.fn(async () => null),
    generatePosOrderNumber: vi.fn(async () => 'POS-1'),
    createPosOrder,
    findEntityById: vi.fn(async (id: string) => ({
      _id: id,
      channel: 'pos',
      status: opts.orderStatus ?? 'pending',
      paymentStatus: 'pending_manual',
      paymentMethod: 'cash',
      total: 15000,
      currency: 'COP',
    })),
    confirmPosPayment: vi.fn(async () => null),
    adminPatch: vi.fn(async () => null),
  }
  const products = {
    getVariantBySku: vi.fn(async (sku: string) => opts.variants[sku] ?? null),
    findBySlugOrId: vi.fn(async (slug: string) => ({
      id: `id-${slug}`,
      slug,
      name: `Producto ${slug}`,
      imagePath: null,
      categorySlug: null,
      variants: Object.values(opts.variants)
        .filter((v) => v.product_slug === slug)
        .map((v) => ({ ...v, inventory: v.sku in available ? [{ is_per_order: false }] : [] })),
    })),
  }
  const inventory = {
    decrementAtomic,
    incrementAtomic: vi.fn(async () => true),
    getBySku: vi.fn(async (sku: string) =>
      sku in available ? { available: available[sku], isPerOrder: false } : null,
    ),
    logMovement: vi.fn(async () => undefined),
  }
  const payments = {
    savePayment: vi.fn(async () => undefined),
    listPaymentsByOrderId: vi.fn(async () => []),
    updatePaymentStatus: vi.fn(async () => undefined),
  }
  const storeSettings = {
    getPaymentSettings: vi.fn(async () => ({
      methods: [
        { methodId: 'cash', isActive: true },
        { methodId: 'bank_transfer', isActive: true },
      ],
      bankTransferDetails: null,
    })),
  }
  const service = new PosSaleService(
    orders as never,
    products as never,
    inventory as never,
    { findActiveAt: async () => [] } as never,
    {} as never,
    payments as never,
    storeSettings as never,
      { findOrCreate: async (input: { name?: string }) => ({ id: 'pc-1', name: input.name || 'Consumidor final', email: null, phone: null }), findById: async () => null, search: async () => [] } as never,
      { enqueue: async () => true } as never,
      { registerPayment: async () => ({}) } as never,
    )
  return { service, orders, inventory, payments }
}

const lavanda = (sku: string, price: number, extra: Partial<Variant> = {}): Variant => ({
  sku,
  product_slug: 'vela-lavanda-zen',
  price,
  currency: 'COP',
  description: 'Pequeña',
  ...extra,
})

const variants = {
  'VELA-P': lavanda('VELA-P', 15000),
  'VELA-M': lavanda('VELA-M', 19000, { description: 'Mediana' }),
  'VELA-G': lavanda('VELA-G', 25000, { description: 'Grande' }),
  'CARD-1': { sku: 'CARD-1', product_slug: 'tarjeta', price: 5000, currency: 'COP' },
  'USD-1': { sku: 'USD-1', product_slug: 'otro', price: 4, currency: 'USD' },
}

const actor = { userId: 'admin-1' }
const KEY = 'idem-key-123456'

function saleInput(overrides: Record<string, unknown> = {}) {
  return {
    customer: { mode: 'walk_in' as const, name: 'Consumidor final' },
    items: [{ sku: 'VELA-P', quantity: 1 }],
    payment: { method: 'cash', state: 'paid' as const, cashReceived: 15000 },
    discountAmount: 0,
    ...overrides,
  } as never
}

describe('POS sale service', () => {
  it('sells a product without variant-specific pricing using the variant price and stock', async () => {
    const { service, orders } = buildService({ variants, available: { 'CARD-1': 3 } })
    const res = await service.createSale(
      saleInput({ items: [{ sku: 'CARD-1', quantity: 2 }], payment: { method: 'cash', state: 'pending_manual' } }),
      actor,
      KEY,
    )
    expect(res.replayed).toBe(false)
    const data = orders.createPosOrder.mock.calls[0][0] as { total: number; items: Array<{ variantSku: string }> }
    expect(data.total).toBe(10000)
    expect(data.items[0].variantSku).toBe('CARD-1')
  })

  it('keeps two different variants of one product as independent lines', async () => {
    const { service, orders } = buildService({ variants, available: { 'VELA-P': 5, 'VELA-M': 5 } })
    await service.createSale(
      saleInput({
        items: [
          { sku: 'VELA-P', quantity: 1 },
          { sku: 'VELA-M', quantity: 2 },
        ],
        payment: { method: 'cash', state: 'pending_manual' },
      }),
      actor,
      KEY,
    )
    const data = orders.createPosOrder.mock.calls[0][0] as {
      subtotal: number
      items: Array<{ variantSku: string; unitPrice: number; subtotal: number }>
    }
    expect(data.items.map((i) => i.variantSku)).toEqual(['VELA-P', 'VELA-M'])
    expect(data.items[1].unitPrice).toBe(19000)
    expect(data.subtotal).toBe(53000)
  })

  it('merges repeated same-variant items into one line', async () => {
    const { service, orders } = buildService({ variants, available: { 'VELA-M': 5 } })
    await service.createSale(
      saleInput({
        items: [
          { sku: 'VELA-M', quantity: 1 },
          { sku: 'VELA-M', quantity: 1 },
        ],
        payment: { method: 'cash', state: 'pending_manual' },
      }),
      actor,
      KEY,
    )
    const data = orders.createPosOrder.mock.calls[0][0] as { items: Array<{ quantity: number }> }
    expect(data.items).toHaveLength(1)
    expect(data.items[0].quantity).toBe(2)
  })

  it('rejects a variant without enough stock and restores nothing it did not decrement', async () => {
    const { service, orders } = buildService({ variants, available: { 'VELA-G': 0 } })
    await expect(
      service.createSale(saleInput({ items: [{ sku: 'VELA-G', quantity: 1 }], payment: { method: 'cash', state: 'pending_manual' } }), actor, KEY),
    ).rejects.toSatisfy((e: unknown) => isAppError(e) && /Sin existencias/.test(String((e as Error).message)))
    expect(orders.createPosOrder).not.toHaveBeenCalled()
  })

  it('rejects mixed currencies instead of converting them', async () => {
    const { service, orders } = buildService({ variants, available: { 'VELA-P': 5 } })
    await expect(
      service.createSale(
        saleInput({
          items: [
            { sku: 'VELA-P', quantity: 1 },
            { sku: 'USD-1', quantity: 1 },
          ],
          payment: { method: 'cash', state: 'pending_manual' },
        }),
        actor,
        KEY,
      ),
    ).rejects.toThrow(/misma moneda/)
    expect(orders.createPosOrder).not.toHaveBeenCalled()
  })

  it('pays cash with exact amount and records received amount and change', async () => {
    const { service, orders } = buildService({ variants, available: { 'VELA-P': 5 } })
    await service.createSale(saleInput({ payment: { method: 'cash', state: 'paid', cashReceived: 15000 } }), actor, KEY)
    const data = orders.createPosOrder.mock.calls[0][0] as Record<string, unknown>
    expect(data.paymentStatus).toBe('paid')
    expect(data.cashReceived).toBe(15000)
    expect(data.changeGiven).toBe(0)
  })

  it('records change when cash received is higher than total, after discount', async () => {
    const { service, orders } = buildService({ variants, available: { 'VELA-M': 5 } })
    await service.createSale(
      saleInput({
        items: [{ sku: 'VELA-M', quantity: 1 }],
        discountAmount: 1000,
        payment: { method: 'cash', state: 'paid', cashReceived: 20000 },
      }),
      actor,
      KEY,
    )
    const data = orders.createPosOrder.mock.calls[0][0] as Record<string, unknown>
    expect(data.total).toBe(18000)
    expect(data.changeGiven).toBe(2000)
  })

  it('rejects cash paid with an insufficient amount', async () => {
    const { service, orders } = buildService({ variants, available: { 'VELA-P': 5 } })
    await expect(
      service.createSale(saleInput({ payment: { method: 'cash', state: 'paid', cashReceived: 10000 } }), actor, KEY),
    ).rejects.toThrow(/no puede ser inferior/)
    expect(orders.createPosOrder).not.toHaveBeenCalled()
  })

  it('never marks a bank transfer as paid on creation', async () => {
    const { service, orders } = buildService({ variants, available: { 'VELA-P': 5 } })
    await service.createSale(
      saleInput({ payment: { method: 'bank_transfer', state: 'paid', transferReference: 'REF-9' } }),
      actor,
      KEY,
    )
    const data = orders.createPosOrder.mock.calls[0][0] as Record<string, unknown>
    expect(data.paymentStatus).toBe('pending_manual')
    expect(data.cashReceived).toBeNull()
    expect(data.changeGiven).toBeNull()
    expect(data.transferReference).toBe('REF-9')
  })

  it('rejects discounts greater than the subtotal', async () => {
    const { service } = buildService({ variants, available: { 'VELA-P': 5 } })
    await expect(
      service.createSale(saleInput({ discountAmount: 99999, payment: { method: 'cash', state: 'pending_manual' } }), actor, KEY),
    ).rejects.toThrow(/descuento/)
  })

  it('returns the original sale when the idempotency key is replayed', async () => {
    const { service, orders } = buildService({ variants, available: { 'VELA-P': 5 } })
    orders.findByIdempotencyKey.mockResolvedValueOnce({
      _id: 'order-x',
      channel: 'pos',
      status: 'pending',
      paymentStatus: 'pending_manual',
      paymentMethod: 'cash',
      total: 15000,
      currency: 'COP',
    } as never)
    const res = await service.createSale(saleInput({ payment: { method: 'cash', state: 'pending_manual' } }), actor, KEY)
    expect(res.replayed).toBe(true)
    expect(orders.createPosOrder).not.toHaveBeenCalled()
  })

  it('refuses to confirm payment on a cancelled sale', async () => {
    const { service } = buildService({ variants, orderStatus: 'cancelled' })
    await expect(service.confirmPayment('order-1', actor, { cashReceived: 99999 })).rejects.toThrow(/cancelada/)
  })

  it('refuses to confirm cash below the total', async () => {
    const { service } = buildService({ variants })
    await expect(service.confirmPayment('order-1', actor, { cashReceived: 1000 })).rejects.toThrow(/no puede ser inferior/)
  })
})

describe('POS product search pagination', () => {
  it('passes page and page size to the repository and reports totals', async () => {
    const searchForPos = vi.fn(async () => ({
      items: [
        {
          id: 'p1',
          slug: 'vela-lavanda-zen',
          name: 'Vela',
          image_path: null,
          variants: [],
        },
      ],
      total: 37,
    }))
    const service = new PosSaleService(
      {} as never,
      { searchForPos } as never,
      {} as never,
      { findActiveAt: async () => [] } as never,
      {} as never,
      {} as never,
      {} as never,
      { findOrCreate: async (input: { name?: string }) => ({ id: 'pc-1', name: input.name || 'Consumidor final', email: null, phone: null }), findById: async () => null, search: async () => [] } as never,
      { enqueue: async () => true } as never,
      { registerPayment: async () => ({}) } as never,
    )
    const res = await service.searchProducts('vela', 2, 10)
    expect(searchForPos).toHaveBeenCalledWith('vela', 2, 10, {})
    expect(res.total).toBe(37)
    expect(res.totalPages).toBe(4)
    expect(res.page).toBe(2)
    expect(res.pageSize).toBe(10)
    expect(res.products).toHaveLength(1)
  })
})

describe('POS payment record consistency', () => {
  it('stores the real method and approved status for a paid cash sale', async () => {
    const { service, payments } = buildService({ variants, available: { 'VELA-P': 5 } })
    await service.createSale(saleInput({ payment: { method: 'cash', state: 'paid', cashReceived: 15000 } }), actor, KEY)
    const payment = (payments.savePayment.mock.calls as unknown as Array<[{ paymentMethod: string; status: string }]>)[0][0]
    expect(payment.paymentMethod).toBe('cash')
    expect(payment.status).toBe('approved')
  })

  it('stores bank transfer as pending until verified', async () => {
    const { service, payments } = buildService({ variants, available: { 'VELA-P': 5 } })
    await service.createSale(
      saleInput({ payment: { method: 'bank_transfer', state: 'pending_manual', transferReference: 'REF-1' } }),
      actor,
      KEY,
    )
    const payment = (payments.savePayment.mock.calls as unknown as Array<[{ paymentMethod: string; status: string }]>)[0][0]
    expect(payment.paymentMethod).toBe('bank_transfer')
    expect(payment.status).toBe('pending')
  })
})

describe('POS financial events (outbox)', () => {
  function outboxSpy(fail = false) {
    const enqueue = vi.fn(async (_event: unknown) => {
      if (fail) throw new Error('outbox down')
      return true
    })
    return { enqueue }
  }

  function serviceWithOutbox(outbox: { enqueue: ReturnType<typeof vi.fn> }, extra: { findByIdempotencyKey?: unknown } = {}) {
    const base = buildService({ variants, available: { 'VELA-P': 5 } })
    if (extra.findByIdempotencyKey !== undefined) {
      base.orders.findByIdempotencyKey.mockResolvedValueOnce(extra.findByIdempotencyKey as never)
    }
    const service = new (base.service.constructor as new (...args: unknown[]) => typeof base.service)(
      base.orders,
      { getVariantBySku: async (sku: string) => variants[sku as keyof typeof variants] ?? null, findBySlugOrId: async (slug: string) => ({
        id: `id-${slug}`, slug, name: `Producto ${slug}`, imagePath: null, categorySlug: null,
        variants: Object.values(variants).filter((v) => v.product_slug === slug).map((v) => ({ ...v, inventory: [{ is_per_order: false }] })),
      }) },
      base.inventory,
      { findActiveAt: async () => [] },
      {},
      { savePayment: async () => undefined, listPaymentsByOrderId: async () => [], updatePaymentStatus: async () => undefined },
      { getPaymentMethods: undefined, getPaymentSettings: async () => ({ methods: [{ methodId: 'cash', isActive: true }, { methodId: 'bank_transfer', isActive: true }], bankTransferDetails: null }) },
      { findOrCreate: async () => ({ id: 'pc-1', name: 'x', email: null, phone: null }), findById: async () => null, search: async () => [] },
      outbox,
    )
    return { service, orders: base.orders }
  }

  it('enqueues sale and payment events for a cash sale paid at checkout', async () => {
    const outbox = outboxSpy()
    const { service } = serviceWithOutbox(outbox)
    await service.createSale(saleInput({ payment: { method: 'cash', state: 'paid', cashReceived: 15000 } }), actor, 'idem-events-1')
    const types = outbox.enqueue.mock.calls.map((c) => (c[0] as { type: string; eventKey: string }).type)
    const keys = outbox.enqueue.mock.calls.map((c) => (c[0] as { eventKey: string }).eventKey)
    expect(types).toEqual(['pos.sale.recorded', 'order.delivered', 'pos.payment.confirmed'])
    expect(keys).toEqual(['pos.sale.recorded:order-1', 'order.delivered:order-1', 'pos.payment.confirmed:order-1'])
  })

  it('enqueues only the sale event for a pending bank transfer', async () => {
    const outbox = outboxSpy()
    const { service } = serviceWithOutbox(outbox)
    await service.createSale(saleInput({ payment: { method: 'bank_transfer', state: 'pending_manual' } }), actor, 'idem-events-2')
    const types = outbox.enqueue.mock.calls.map((c) => (c[0] as { type: string }).type)
    expect(types).toEqual(['pos.sale.recorded', 'order.delivered'])
  })

  it('does not fail the sale when the outbox is unavailable', async () => {
    const outbox = outboxSpy(true)
    const { service } = serviceWithOutbox(outbox)
    const res = await service.createSale(saleInput({ payment: { method: 'bank_transfer', state: 'pending_manual' } }), actor, 'idem-events-3')
    expect(res.replayed).toBe(false)
    expect(outbox.enqueue).toHaveBeenCalled()
  })

  it('re-ensures events on an idempotent replay', async () => {
    const outbox = outboxSpy()
    const existing = {
      _id: 'order-r', channel: 'pos', status: 'pending', paymentStatus: 'pending_manual', paymentMethod: 'cash',
      total: 15000, currency: 'COP', subtotal: 15000, items: [], createdAt: new Date(),
      receiptNumber: 'POS-R', userId: null,
    }
    const { service } = serviceWithOutbox(outbox, { findByIdempotencyKey: existing })
    const res = await service.createSale(saleInput({ payment: { method: 'cash', state: 'pending_manual' } }), actor, 'idem-events-4')
    expect(res.replayed).toBe(true)
    expect(outbox.enqueue).toHaveBeenCalledTimes(1)
    expect((outbox.enqueue.mock.calls[0][0] as { eventKey: string }).eventKey).toBe('pos.sale.recorded:order-r')
  })
})

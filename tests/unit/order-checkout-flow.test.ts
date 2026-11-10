import { describe, it, expect, vi, beforeEach } from 'vitest'
import { OrderService } from '../../src/modules/sales/services/order.service.js'
import { ManualPaymentService } from '../../src/modules/payments/services/manual-payment.service.js'
import { createOrderSchema } from '../../src/modules/sales/schemas/order.schema.js'
import type { DepositPolicy } from '../../src/modules/catalog/domain/deposit-policy.js'

/** El cliente solo debe ver el mensaje general, nunca el detalle de configuración. */
function expectGenericPricingError(error: unknown) {
  expect(error).toMatchObject({ statusCode: 503, code: 'PRICING_UNAVAILABLE' })
  expect(String((error as Error).message)).not.toMatch(/política|materiales|SKU|configur/i)
}

vi.mock('../../src/modules/sales/utils/order-access-token.utils.js', () => ({
  signOrderAccessToken: () => 'token-test',
}))

type InvRow = { isPerOrder: boolean; available: number; depositPolicy: DepositPolicy | null }

const CATALOG: Record<string, { slug: string; name: string; variants: Array<{ sku: string; price: number }> }> = {
  lampara: { slug: 'lampara', name: 'Lámpara', variants: [{ sku: 'LAMP-01', price: 100000 }] },
  mesa: { slug: 'mesa', name: 'Mesa', variants: [{ sku: 'MESA-01', price: 1000000 }] },
  estanteria: { slug: 'estanteria', name: 'Estantería', variants: [{ sku: 'EST-01', price: 500000 }] },
}

const cartLine = (sku: string, slug: string, unitPrice: number, quantity = 1) => ({
  sku,
  productSlug: slug,
  productName: CATALOG[slug]!.name,
  quantity,
  unitPrice,
  currency: 'COP',
})

function setup(
  inventoryRows: Record<string, InvRow>,
  cartItems: ReturnType<typeof cartLine>[] = [],
  materialCosts: Record<string, number> = {},
) {
  const inventoryState = { ...inventoryRows }
  const inventory = {
    getBySku: vi.fn(async (sku: string) => {
      const row = inventoryState[sku]
      if (!row) return null
      return { available: row.available, isPerOrder: row.isPerOrder, depositPolicy: row.depositPolicy }
    }),
  }

  const persisted = new Map<string, Record<string, unknown>>()
  let seq = 0
  const orders = {
    findByUser: vi.fn(async () => null),
    createOrder: vi.fn(async (data: Record<string, unknown>) => {
      const id = `order-${++seq}`
      persisted.set(id, { ...data, _id: id })
      return { ...data, id, orderNumber: `LUM-${seq}` }
    }),
    findByIdSafe: vi.fn(async (id: string) => {
      const o = persisted.get(id)
      if (!o) return null
      return {
        id,
        userId: null,
        total: o.total,
        initialPaymentRequired: o.initialPaymentRequired,
        currency: 'COP',
        status: 'pending',
        paymentStatus: 'unpaid',
        orderNumber: `LUM-${id}`,
      }
    }),
    updatePaymentStatus: vi.fn(async () => undefined),
  }

  const payments = {
    listPaymentsByOrderId: vi.fn(async () => []),
    savePayment: vi.fn(async (p: { _id?: string }) => p._id ?? 'payment-id'),
  }
  const carts = {
    findByKey: vi.fn(async () => ({ items: cartItems })),
    clear: vi.fn(async () => undefined),
  }
  const products = {
    findTaxRatesBySlugs: vi.fn(async () => new Map<string, number | null>()),
    findBySlugOrId: vi.fn(async (idOrSlug: string) => CATALOG[idOrSlug] ?? null),
  }
  const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn() }
  const costSheets = {
    getLatestByVariantSku: vi.fn(async (sku: string) =>
      materialCosts[sku] != null ? { materialsCost: materialCosts[sku]! } : null,
    ),
  }
  const mail = { notifyPreOrderCreated: vi.fn() }
  const push = { notifyPreOrderCreated: vi.fn() }

  const manualPayments = new ManualPaymentService(payments as never, orders as never, carts as never)
  const service = new OrderService(
    orders as never,
    carts as never,
    inventory as never,
    manualPayments,
    mail as never,
    push as never,
    products as never,
    costSheets as never,
    logger as never,
  )
  return { service, orders, payments, inventoryState, manualPayments, logger }
}

const shipping = {
  customerName: 'Ana Pérez',
  phone: '3001234567',
  address: 'Calle 1 # 2-3',
  city: 'Bogotá',
  reference: '',
} as never

const MESA_FIXED: DepositPolicy = { type: 'fixed', value: 350000 }
const EST_PERCENT: DepositPolicy = { type: 'percent', value: 35 }

describe('checkout desde carrito (ruta principal)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('pedido mixto: cobra 100 % del stock y solo el anticipo de cada producto por pedido', async () => {
    const { service, orders, payments } = setup(
      {
        'LAMP-01': { isPerOrder: false, available: 10, depositPolicy: null },
        'MESA-01': { isPerOrder: true, available: 0, depositPolicy: MESA_FIXED },
        'EST-01': { isPerOrder: true, available: 0, depositPolicy: EST_PERCENT },
      },
      [cartLine('LAMP-01', 'lampara', 100000), cartLine('MESA-01', 'mesa', 1000000), cartLine('EST-01', 'estanteria', 500000)],
    )

    const result = await service.createFromCheckout('cart-1', shipping, null, 'ana@example.com')

    const saved = orders.createOrder.mock.calls[0]![0] as Record<string, unknown>
    expect(saved.total).toBe(1600000)
    expect(saved.initialPaymentRequired).toBe(625000)
    expect(saved.balanceDue).toBe(975000)
    expect(saved.paidAmount).toBe(0)

    const items = saved.items as Array<Record<string, unknown>>
    expect(items.map((i) => [i.fulfillmentMode, i.initialPaymentRequired, i.balanceDue])).toEqual([
      ['stock', 100000, 0],
      ['made_to_order', 350000, 650000],
      ['made_to_order', 175000, 325000],
    ])

    // El pago creado es el pago inicial exigido, no el total del pedido.
    const payment = payments.savePayment.mock.calls[0]![0] as { amount: number }
    expect(payment.amount).toBe(625000)
    expect(result.initialPaymentRequired).toBe(625000)
    expect(result.balanceDue).toBe(975000)
    expect(result.total).toBe(1600000)
  })

  it('pedido solo de stock: el pago inicial es el 100 % del total', async () => {
    const { service, orders, payments } = setup(
      { 'LAMP-01': { isPerOrder: false, available: 10, depositPolicy: null } },
      [cartLine('LAMP-01', 'lampara', 100000, 2)],
    )
    await service.createFromCheckout('cart-2', shipping, null, null)
    const saved = orders.createOrder.mock.calls[0]![0] as Record<string, unknown>
    expect(saved.initialPaymentRequired).toBe(200000)
    expect(saved.balanceDue).toBe(0)
    expect((payments.savePayment.mock.calls[0]![0] as { amount: number }).amount).toBe(200000)
  })

  it('varias unidades de un SKU por pedido: el anticipo fijo se multiplica por la cantidad', async () => {
    const { service, orders } = setup(
      { 'MESA-01': { isPerOrder: true, available: 0, depositPolicy: MESA_FIXED } },
      [cartLine('MESA-01', 'mesa', 1000000, 3)],
    )
    await service.createFromCheckout('cart-3', shipping, null, null)
    const saved = orders.createOrder.mock.calls[0]![0] as Record<string, unknown>
    expect(saved.total).toBe(3000000)
    expect(saved.initialPaymentRequired).toBe(1050000)
    expect(saved.balanceDue).toBe(1950000)
  })

  it('producto por pedido sin política bloquea el pedido: no se crea orden ni pago', async () => {
    const { service, orders, payments, logger } = setup(
      { 'MESA-01': { isPerOrder: true, available: 0, depositPolicy: null } },
      [cartLine('MESA-01', 'mesa', 1000000)],
    )
    const error = await service.createFromCheckout('cart-4', shipping, null, null).catch((e: unknown) => e)
    expectGenericPricingError(error)
    expect(logger.error.mock.calls[0]![0]).toMatchObject({ reason: 'missing_policy', sku: 'MESA-01' })
    expect(orders.createOrder).not.toHaveBeenCalled()
    expect(payments.savePayment).not.toHaveBeenCalled()
  })

  it('política de materiales sin costo confiable bloquea el pedido', async () => {
    const { service, orders, logger } = setup(
      { 'MESA-01': { isPerOrder: true, available: 0, depositPolicy: { type: 'materials', value: 50 } } },
      [cartLine('MESA-01', 'mesa', 1000000)],
    )
    const error = await service.createFromCheckout('cart-5', shipping, null, null).catch((e: unknown) => e)
    expectGenericPricingError(error)
    expect(logger.error.mock.calls[0]![0]).toMatchObject({ reason: 'missing_material_cost', sku: 'MESA-01' })
    expect(orders.createOrder).not.toHaveBeenCalled()
  })

  it('la política se fotografía: cambiar el SKU después no altera el pedido creado', async () => {
    const { service, orders, inventoryState } = setup(
      { 'MESA-01': { isPerOrder: true, available: 0, depositPolicy: MESA_FIXED } },
      [cartLine('MESA-01', 'mesa', 1000000)],
    )
    await service.createFromCheckout('cart-6', shipping, null, null)
    inventoryState['MESA-01'] = { isPerOrder: true, available: 0, depositPolicy: { type: 'percent', value: 90 } }

    const saved = orders.createOrder.mock.calls[0]![0] as { items: Array<{ depositPolicy: DepositPolicy }> }
    expect(saved.items[0]!.depositPolicy).toEqual(MESA_FIXED)
  })
})

describe('creación por la ruta alternativa dto.items', () => {
  beforeEach(() => vi.clearAllMocks())

  const baseBody = {
    customerName: 'Ana Pérez',
    phone: '3001234567',
    address: 'Calle 1 # 2-3',
    city: 'Bogotá',
  }
  const parse = (extra: Record<string, unknown>) => createOrderSchema.parse({ ...baseBody, ...extra })

  it('el cliente no puede decidir modalidad ni política: Server usa su inventario', async () => {
    const { service, orders } = setup({
      'LAMP-01': { isPerOrder: false, available: 10, depositPolicy: null },
      'MESA-01': { isPerOrder: true, available: 0, depositPolicy: MESA_FIXED },
    })
    const dto = parse({
      items: [
        { productId: 'lampara', variantSku: 'LAMP-01', name: 'Lámpara', quantity: 1, unitPrice: 1, subtotal: 1 },
        {
          productId: 'mesa',
          variantSku: 'MESA-01',
          name: 'Mesa',
          quantity: 1,
          unitPrice: 1,
          subtotal: 1,
          // Campos manipulados: el esquema los descarta y Server no los lee.
          fulfillmentMode: 'stock',
          depositPolicy: { type: 'percent', value: 1 },
        },
      ],
      total: 1100000,
    })

    await service.create(dto, null, null)

    const saved = orders.createOrder.mock.calls[0]![0] as Record<string, unknown>
    expect(saved.total).toBe(1100000)
    expect(saved.initialPaymentRequired).toBe(450000)
    expect(saved.balanceDue).toBe(650000)
    const items = saved.items as Array<Record<string, unknown>>
    expect(items[1]).toMatchObject({
      fulfillmentMode: 'made_to_order',
      depositPolicy: MESA_FIXED,
      unitPrice: 1000000,
      initialPaymentRequired: 350000,
      balanceDue: 650000,
    })
    expect(items[0]).toMatchObject({ fulfillmentMode: 'stock', unitPrice: 100000 })
  })

  it('un total enviado por el cliente distinto al de Server se rechaza', async () => {
    const { service, orders } = setup({ 'LAMP-01': { isPerOrder: false, available: 10, depositPolicy: null } })
    const dto = parse({
      items: [{ productId: 'lampara', variantSku: 'LAMP-01', name: 'Lámpara', quantity: 1, unitPrice: 1, subtotal: 1 }],
      total: 1,
    })
    await expect(service.create(dto, null, null)).rejects.toThrow(/no coincide/)
    expect(orders.createOrder).not.toHaveBeenCalled()
  })

  it('envío, impuestos o descuentos enviados por el cliente se rechazan', async () => {
    const { service, orders } = setup({ 'LAMP-01': { isPerOrder: false, available: 10, depositPolicy: null } })
    const dto = parse({
      items: [{ productId: 'lampara', variantSku: 'LAMP-01', name: 'Lámpara', quantity: 1, unitPrice: 1, subtotal: 1 }],
      total: 100000,
      discountAmount: 5000,
    })
    await expect(service.create(dto, null, null)).rejects.toThrow(/calcula el servidor/)
    expect(orders.createOrder).not.toHaveBeenCalled()
  })

  it('una línea sin SKU de variante o con SKU ajeno al producto se rechaza', async () => {
    const { service, orders } = setup({})
    const noSku = parse({
      items: [{ productId: 'lampara', name: 'Lámpara', quantity: 1, unitPrice: 1, subtotal: 1 }],
      total: 100000,
    })
    await expect(service.create(noSku, null, null)).rejects.toThrow(/Falta la variante/)

    const foreignSku = parse({
      items: [{ productId: 'lampara', variantSku: 'MESA-01', name: 'Lámpara', quantity: 1, unitPrice: 1, subtotal: 1 }],
      total: 1000000,
    })
    await expect(service.create(foreignSku, null, null)).rejects.toThrow(/no está disponible/)
    expect(orders.createOrder).not.toHaveBeenCalled()
  })

  it('producto por pedido sin política también bloquea la ruta dto.items', async () => {
    const { service, orders, logger } = setup({ 'MESA-01': { isPerOrder: true, available: 0, depositPolicy: null } })
    const dto = parse({
      items: [{ productId: 'mesa', variantSku: 'MESA-01', name: 'Mesa', quantity: 1, unitPrice: 1, subtotal: 1 }],
      total: 1000000,
    })
    const error = await service.create(dto, null, null).catch((e: unknown) => e)
    expectGenericPricingError(error)
    expect(logger.error.mock.calls[0]![0]).toMatchObject({ reason: 'missing_policy', sku: 'MESA-01' })
    expect(orders.createOrder).not.toHaveBeenCalled()
  })
})

describe('pagos: pendientes, confirmados y sin duplicados', () => {
  beforeEach(() => vi.clearAllMocks())

  it('reintentar la creación del pago pendiente no duplica el cobro', async () => {
    const { manualPayments, payments } = setup({})
    const pendingStore: Array<{ _id: string; paymentMethod: string; status: string }> = []
    payments.listPaymentsByOrderId.mockImplementation(async () => pendingStore as never)
    payments.savePayment.mockImplementation(async (p: { _id?: string }) => {
      const id = `payment-${pendingStore.length + 1}`
      pendingStore.push({ ...p, _id: id, paymentMethod: 'manual', status: 'pending' } as never)
      return id
    })
    const orders = (manualPayments as unknown as { orders: { findByIdSafe: (id: string) => Promise<unknown> } }).orders
    vi.spyOn(orders, 'findByIdSafe').mockResolvedValue({
      id: 'o1',
      total: 1600000,
      initialPaymentRequired: 625000,
      currency: 'COP',
      status: 'pending',
      paymentStatus: 'unpaid',
      userId: null,
    } as never)

    const first = await manualPayments.createForOrder('o1')
    const second = await manualPayments.createForOrder('o1')

    expect(payments.savePayment).toHaveBeenCalledTimes(1)
    expect(second.paymentId).toBe(first.paymentId)
  })

  it('pedido anterior a G2 sin pago inicial registrado: el pago exige el total', async () => {
    const { manualPayments, payments } = setup({})
    vi.spyOn(
      (manualPayments as unknown as { orders: { findByIdSafe: (id: string) => Promise<unknown> } }).orders,
      'findByIdSafe',
    ).mockResolvedValue({
      id: 'legacy',
      total: 500000,
      currency: 'COP',
      status: 'pending',
      paymentStatus: 'unpaid',
      userId: null,
    } as never)

    await manualPayments.createForOrder('legacy')
    expect((payments.savePayment.mock.calls[0]![0] as { amount: number }).amount).toBe(500000)
  })
})

describe('G3 — costo de materiales y cancelación con pagos', () => {
  beforeEach(() => vi.clearAllMocks())

  it('política por materiales usa la hoja de costo del SKU × cantidad', async () => {
    // Hoja de costo: materiales $200.000 por unidad. Dos unidades → $400.000 de materiales.
    // Anticipo 50 % de materiales = $200.000; total línea $2.000.000.
    const { service, orders } = setup(
      { 'MESA-01': { isPerOrder: true, available: 0, depositPolicy: { type: 'materials', value: 50 } } },
      [cartLine('MESA-01', 'mesa', 1000000, 2)],
      { 'MESA-01': 200000 },
    )
    await service.createFromCheckout('cart-m1', shipping, null, null)
    const saved = orders.createOrder.mock.calls[0]![0] as Record<string, unknown>
    expect(saved.initialPaymentRequired).toBe(200000)
    expect(saved.balanceDue).toBe(1800000)
  })

  it('política por materiales sin hoja de costo para el SKU bloquea el pedido', async () => {
    const { service, orders, logger } = setup(
      { 'MESA-01': { isPerOrder: true, available: 0, depositPolicy: { type: 'materials', value: 50 } } },
      [cartLine('MESA-01', 'mesa', 1000000)],
      {},
    )
    const error = await service.createFromCheckout('cart-m2', shipping, null, null).catch((e: unknown) => e)
    expectGenericPricingError(error)
    expect(logger.error.mock.calls[0]![0]).toMatchObject({ reason: 'missing_material_cost', sku: 'MESA-01' })
    expect(orders.createOrder).not.toHaveBeenCalled()
  })

  it('no se puede cancelar desde la tienda un pedido con pagos registrados', async () => {
    const { service, orders } = setup({})
    orders.findByUser.mockResolvedValueOnce({
      id: 'o9',
      status: 'pending',
      paymentStatus: 'deposit_paid',
      paidAmount: 625000,
    } as never)
    await expect(service.cancel('o9', 'user-1')).rejects.toThrow(/pagos registrados/)
  })
})

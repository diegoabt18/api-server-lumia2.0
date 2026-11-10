import { describe, it, expect, vi } from 'vitest'
import { OrderPaymentService } from '../../src/modules/sales/services/order-payment.service.js'
import { AdminInventoryService } from '../../src/modules/admin/services/admin-inventory.service.js'
import { OrderService } from '../../src/modules/sales/services/order.service.js'

// ───── Pedido y libro de pagos en memoria, con bloqueo por pedido igual que el repositorio ─────

function makeLedger(opts: { yieldBeforeWrite?: boolean } = {}) {
  const locks = new Map<string, string>()
  const state = {
    order: {
      _id: 'o1',
      total: 1600000,
      status: 'pending',
      currency: 'COP',
      items: [
        { name: 'Lámpara', variantSku: 'LAMP-01', subtotal: 100000, initialPaymentRequired: 100000, fulfillmentMode: 'stock' },
        { name: 'Mesa', variantSku: 'MESA-01', subtotal: 1000000, initialPaymentRequired: 350000, fulfillmentMode: 'made_to_order' },
        { name: 'Estantería', variantSku: 'EST-01', subtotal: 500000, initialPaymentRequired: 175000, fulfillmentMode: 'made_to_order' },
      ] as Array<Record<string, unknown>>,
      paidAmount: 0,
      balanceDue: 1600000,
      paymentStatus: 'unpaid',
    },
    payments: [] as Array<Record<string, unknown>>,
  }
  let seq = 0
  const pause = async () => {
    if (opts.yieldBeforeWrite) await new Promise((r) => setTimeout(r, 5))
  }

  const orders = {
    acquireLedgerLock: vi.fn(async (id: string, token: string) => {
      if (locks.has(id)) return false
      locks.set(id, token)
      return true
    }),
    releaseLedgerLock: vi.fn(async (id: string, token: string) => {
      if (locks.get(id) === token) locks.delete(id)
    }),
    findEntityById: vi.fn(async () => ({ ...state.order, items: state.order.items.map((i) => ({ ...i })) })),
    applyPaymentLedger: vi.fn(async (_id: string, data: Record<string, unknown>) => {
      await pause()
      const o = state.order as Record<string, unknown>
      o.paidAmount = data.paidAmount
      o.balanceDue = data.balanceDue
      o.paymentStatus = data.paymentStatus
      if (data.markPaid) o.status = 'paid'
      return { ...state.order, items: state.order.items.map((i) => ({ ...i })) }
    }),
  }
  const payments = {
    listPaymentsByOrderId: vi.fn(async () => state.payments.map((p) => ({ ...p }))),
    savePayment: vi.fn(async (p: Record<string, unknown>) => {
      await pause()
      const id = `pay-${++seq}`
      state.payments.push({ ...p, _id: id })
      return id
    }),
    findApprovedByProviderReference: vi.fn(async (method: string, ref: string) =>
      state.payments.find((p) => p.paymentMethod === method && p.providerPaymentId === ref && p.status === 'approved') ?? null,
    ),
    findPaymentByExternalReference: vi.fn(async (ref: string) =>
      state.payments.find((p) => p.externalReference === ref) ?? null,
    ),
    updatePaymentStatus: vi.fn(async () => undefined),
  }
  const stock = { applyOnPaid: vi.fn(async () => true) }
  const service = new OrderPaymentService(orders as never, payments as never, stock as never)
  return { service, state, orders, payments, stock }
}

const actor = { userId: 'admin-1' }

describe('G3 — concurrencia y reintentos de pagos', () => {
  it('dos cobros simultáneos sobre el mismo saldo: solo uno se registra, nunca hay sobrepago', async () => {
    const { service, state } = makeLedger({ yieldBeforeWrite: true })
    const results = await Promise.allSettled([
      service.registerPayment('o1', { method: 'cash', amount: 625000, receivedAmount: 625000 }, actor),
      service.registerPayment('o1', { method: 'cash', amount: 625000, receivedAmount: 625000 }, actor),
    ])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(String(rejected[0]!.reason.message)).toMatch(/otro cobro en curso/)
    const approved = state.payments.filter((p) => p.status === 'approved')
    expect(approved).toHaveLength(1)
    expect(state.order.paidAmount).toBe(625000)
  })

  it('un cobro que no obtiene el bloqueo no escribe ningún pago', async () => {
    const { service, payments, orders } = makeLedger()
    orders.acquireLedgerLock.mockResolvedValueOnce(false)
    await expect(
      service.registerPayment('o1', { method: 'cash', amount: 100, receivedAmount: 100 }, actor),
    ).rejects.toThrow(/otro cobro en curso/)
    expect(payments.savePayment).not.toHaveBeenCalled()
  })

  it('el bloqueo se libera aunque el registro falle (no queda el pedido bloqueado)', async () => {
    const { service, orders } = makeLedger()
    await expect(
      service.registerPayment('o1', { method: 'cash', amount: 999999999, receivedAmount: 999999999 }, actor),
    ).rejects.toThrow(/registra exactamente su importe: 625000/)
    expect(orders.releaseLedgerLock).toHaveBeenCalledTimes(1)
    // Un intento válido posterior sí puede adquirir el bloqueo.
    await expect(
      service.registerPayment('o1', { method: 'cash', amount: 625000, receivedAmount: 625000 }, actor),
    ).resolves.toMatchObject({ paidAmount: 625000 })
  })

  it('reintento con la misma clave de idempotencia no cobra dos veces', async () => {
    const { service, state, payments } = makeLedger()
    const first = await service.registerPayment(
      'o1',
      { method: 'cash', amount: 625000, receivedAmount: 625000, idempotencyKey: 'abc-123' },
      actor,
    )
    const second = await service.registerPayment(
      'o1',
      { method: 'cash', amount: 625000, receivedAmount: 625000, idempotencyKey: 'abc-123' },
      actor,
    )
    expect(payments.savePayment).toHaveBeenCalledTimes(1)
    expect(state.payments).toHaveLength(1)
    expect(second.paidAmount).toBe(first.paidAmount)
    expect(second.balanceDue).toBe(first.balanceDue)
  })

  it('transferencia repetida con otra clave sigue rechazada por referencia', async () => {
    const { service } = makeLedger()
    await service.registerPayment('o1', { method: 'bank_transfer', amount: 625000, transferReference: 'TRF-77' }, actor)
    await expect(
      service.registerPayment('o1', { method: 'bank_transfer', amount: 975000, transferReference: 'TRF-77', idempotencyKey: 'otra' }, actor),
    ).rejects.toThrow(/ya fue registrada/)
  })
})

// ───── Auditoría de políticas de anticipo ─────

function makeInventory(previous: unknown = null) {
  const rows = new Map<string, Record<string, unknown>>()
  rows.set('MESA-01', { sku: 'MESA-01', deposit_policy: previous, deposit_policy_version: 1 })
  return {
    rows,
    getDepositPolicy: vi.fn(async (sku: string) => (rows.get(sku)?.deposit_policy as never) ?? null),
    getDepositPolicyState: vi.fn(async (sku: string) => ({
      policy: (rows.get(sku)?.deposit_policy as never) ?? null,
      version: (rows.get(sku)?.deposit_policy_version as number) ?? 0,
    })),
    compareAndSetDepositPolicy: vi.fn(async (sku: string, expected: number, policy: unknown) => {
      const row = rows.get(sku) ?? { sku }
      if (((row.deposit_policy_version as number) ?? 0) !== expected) return false
      row.deposit_policy = policy
      row.deposit_policy_version = expected + 1
      rows.set(sku, row)
      return true
    }),
    upsertBySku: vi.fn(async (data: Record<string, unknown>) => {
      const current = rows.get(data.sku as string) ?? { sku: data.sku }
      if (data.deposit_policy !== undefined) current.deposit_policy = data.deposit_policy
      rows.set(data.sku as string, current)
    }),
  }
}

describe('G3 — auditoría de políticas de anticipo', () => {
  it('registra quién cambió la política, la anterior y la nueva; ignora el autorizador enviado por el navegador', async () => {
    const inventory = makeInventory({ type: 'fixed', value: 300000 })
    const audit = { insert: vi.fn(async (_e: Record<string, unknown>) => undefined) }
    const service = new AdminInventoryService(inventory as never, audit as never)

    await service.upsertBySku(
      'MESA-01',
      {
        expected_version: 1,
        deposit_policy: {
          type: 'custom_authorized',
          value: 120000,
          authorization: { authorizedBy: 'alguien-falso', reason: 'acuerdo comercial' },
        },
      },
      'user-42',
    )

    const entry = audit.insert.mock.calls[0]![0] as Record<string, unknown>
    expect(entry.event_type).toBe('deposit_policy_changed')
    expect(entry.entity_id).toBe('MESA-01')
    expect(entry.previous_value).toEqual({ type: 'fixed', value: 300000 })
    const next = entry.new_value as { authorization: { authorizedBy: string; reason: string } }
    expect(next.authorization.authorizedBy).toBe('user-42')
    expect(next.authorization.reason).toBe('acuerdo comercial')
    expect(String(entry.performed_by)).toBe('user-42')
  })

  it('eliminar una política queda registrado como evento propio', async () => {
    const inventory = makeInventory({ type: 'percent', value: 35 })
    const audit = { insert: vi.fn(async (_e: Record<string, unknown>) => undefined) }
    const service = new AdminInventoryService(inventory as never, audit as never)
    await service.upsertBySku('MESA-01', { deposit_policy: null, expected_version: 1 }, 'user-1')
    const entry = audit.insert.mock.calls[0]![0] as Record<string, unknown>
    expect(entry.event_type).toBe('deposit_policy_removed')
    expect(entry.previous_value).toEqual({ type: 'percent', value: 35 })
    expect(entry.new_value).toBeNull()
  })

  it('si la auditoría falla, la política anterior se restaura: no hay cambio sin registro', async () => {
    const inventory = makeInventory({ type: 'fixed', value: 300000 })
    const audit = { insert: vi.fn(async () => { throw new Error('db caída') }) }
    const service = new AdminInventoryService(inventory as never, audit as never)
    await expect(
      service.upsertBySku('MESA-01', { deposit_policy: { type: 'percent', value: 50 }, expected_version: 1 }, 'user-1'),
    ).rejects.toThrow(/db caída/)
    expect(inventory.rows.get('MESA-01')?.deposit_policy).toEqual({ type: 'fixed', value: 300000 })
  })

  it('con una versión obsoleta la escritura se rechaza y no cambia nada (control optimista)', async () => {
    const inventory = makeInventory({ type: 'fixed', value: 300000 })
    const audit = { insert: vi.fn(async (_e: Record<string, unknown>) => undefined) }
    const service = new AdminInventoryService(inventory as never, audit as never)
    await expect(
      service.upsertBySku('MESA-01', { deposit_policy: { type: 'percent', value: 50 }, expected_version: 0 }, 'user-1'),
    ).rejects.toThrow(/cambió mientras la editabas/)
    expect(inventory.rows.get('MESA-01')?.deposit_policy).toEqual({ type: 'fixed', value: 300000 })
    expect(audit.insert).not.toHaveBeenCalled()
  })

  it('una política sin versión esperada se rechaza antes de tocar la base', async () => {
    const inventory = makeInventory(null)
    const audit = { insert: vi.fn(async (_e: Record<string, unknown>) => undefined) }
    const service = new AdminInventoryService(inventory as never, audit as never)
    await expect(
      service.upsertBySku('MESA-01', { deposit_policy: { type: 'percent', value: 50 } }, 'user-1'),
    ).rejects.toThrow(/expected_version|versión/)
    expect(inventory.compareAndSetDepositPolicy).not.toHaveBeenCalled()
  })

  it('una actualización sin política (solo stock) no genera registro de auditoría', async () => {
    const inventory = makeInventory(null)
    const audit = { insert: vi.fn(async (_e: Record<string, unknown>) => undefined) }
    const service = new AdminInventoryService(inventory as never, audit as never)
    await service.upsertBySku('MESA-01', { quantity: 5 }, 'user-1')
    expect(audit.insert).not.toHaveBeenCalled()
  })
})

// ───── Cotización del carrito ─────

describe('G3 — cotización autoritativa del carrito', () => {
  it('devuelve los mismos importes que el checkout, sin crear pedido', async () => {
    const carts = {
      findByKey: vi.fn(async () => ({
        items: [
          { sku: 'LAMP-01', productSlug: 'lampara', productName: 'Lámpara', quantity: 1, unitPrice: 100000, currency: 'COP' },
          { sku: 'MESA-01', productSlug: 'mesa', productName: 'Mesa', quantity: 1, unitPrice: 1000000, currency: 'COP' },
          { sku: 'EST-01', productSlug: 'estanteria', productName: 'Estantería', quantity: 1, unitPrice: 500000, currency: 'COP' },
        ],
      })),
    }
    const inventory = {
      getBySku: vi.fn(async (sku: string) => {
        if (sku === 'LAMP-01') return { available: 10, isPerOrder: false, depositPolicy: null }
        if (sku === 'MESA-01') return { available: 0, isPerOrder: true, depositPolicy: { type: 'fixed', value: 350000 } }
        if (sku === 'EST-01') return { available: 0, isPerOrder: true, depositPolicy: { type: 'percent', value: 35 } }
        return null
      }),
    }
    const orders = { createOrder: vi.fn() }
    const service = new OrderService(
      orders as never,
      carts as never,
      inventory as never,
      {} as never,
      {} as never,
      {} as never,
      { findTaxRatesBySlugs: vi.fn(async () => new Map()) } as never,
      undefined,
    )

    const quote = await service.quoteFromCart('cart-1')
    expect(quote.total).toBe(1600000)
    expect(quote.initialPaymentRequired).toBe(625000)
    expect(quote.balanceDue).toBe(975000)
    expect(quote.items.map((i) => i.fulfillmentMode)).toEqual(['stock', 'made_to_order', 'made_to_order'])
    expect(orders.createOrder).not.toHaveBeenCalled()
  })

  it('sin carrito la cotización es vacía', async () => {
    const service = new OrderService({} as never, { findByKey: vi.fn() } as never, {} as never, {} as never, {} as never, {} as never, {} as never, undefined)
    await expect(service.quoteFromCart(null)).resolves.toMatchObject({ total: 0, items: [] })
  })
})

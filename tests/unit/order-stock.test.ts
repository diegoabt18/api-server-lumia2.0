import { describe, it, expect, vi } from 'vitest'
import { OrderStockService } from '../../src/modules/sales/services/order-stock.service.js'
import { AdminOrderService } from '../../src/modules/admin/services/admin-order.service.js'

type Line = { productId: string; variantSku?: string; quantity: number }

function order(overrides: Partial<{ _id: string; status: string; paymentStatus: string; items: Line[]; stockDecrementedAt: Date | null; stockRestoredAt: Date | null }> = {}) {
  return {
    _id: 'o1',
    status: 'pending',
    paymentStatus: 'unpaid',
    items: [{ productId: 'p1', variantSku: 'VELA-M', quantity: 2 }],
    stockDecrementedAt: null,
    stockRestoredAt: null,
    total: 100,
    currency: 'COP',
    ...overrides,
  }
}

function fakes(opts: { tracked?: Record<string, { isPerOrder: boolean }>; claim?: boolean } = {}) {
  const tracked = opts.tracked ?? { 'VELA-M': { isPerOrder: false } }
  const inventory = {
    getBySku: vi.fn(async (sku: string) => tracked[sku] ?? null),
    decrementAtomic: vi.fn(async (..._args: unknown[]) => true),
    incrementAtomic: vi.fn(async (..._args: unknown[]) => undefined),
  }
  const orders = {
    claimStockDecrement: vi.fn(async (..._args: unknown[]) => opts.claim ?? true),
    recordInventoryFailure: vi.fn(async (..._args: unknown[]) => undefined),
    markStockRestored: vi.fn(async (..._args: unknown[]) => true),
    findEntityById: vi.fn(async (..._args: unknown[]) => null),
    adminPatch: vi.fn(async (..._args: unknown[]) => null),
    resolveCancellationRequest: vi.fn(async (..._args: unknown[]) => null),
    markFinalPaymentPaid: vi.fn(async (..._args: unknown[]) => null),
  }
  return { inventory, orders, service: new OrderStockService(inventory as never, orders as never) }
}

describe('OrderStockService', () => {
  it('decrements tracked variants by SKU once the order is paid', async () => {
    const { inventory, service } = fakes()
    const applied = await service.applyOnPaid(order() as never)
    expect(applied).toBe(true)
    expect(inventory.decrementAtomic).toHaveBeenCalledWith('VELA-M', 2)
  })

  it('does not decrement twice when the order was already claimed', async () => {
    const { inventory, service } = fakes({ claim: false })
    expect(await service.applyOnPaid(order() as never)).toBe(false)
    expect(inventory.decrementAtomic).not.toHaveBeenCalled()
  })

  it('skips variants without inventory record or made to order', async () => {
    const { inventory, service } = fakes({ tracked: { 'VELA-M': { isPerOrder: true } } })
    await service.applyOnPaid(order() as never)
    expect(inventory.decrementAtomic).not.toHaveBeenCalled()
  })

  it('records lines that could not be decremented', async () => {
    const { inventory, orders, service } = fakes()
    inventory.decrementAtomic.mockResolvedValueOnce(false)
    await service.applyOnPaid(order() as never)
    expect(orders.recordInventoryFailure).toHaveBeenCalledWith('o1', ['VELA-M: sin existencias suficientes'])
  })

  it('restores stock only when this order had decremented it', async () => {
    const { inventory, service } = fakes()
    expect(await service.restoreIfDecremented(order() as never)).toBe(false)
    expect(inventory.incrementAtomic).not.toHaveBeenCalled()

    const decremented = order({ stockDecrementedAt: new Date() })
    expect(await service.restoreIfDecremented(decremented as never)).toBe(true)
    expect(inventory.incrementAtomic).toHaveBeenCalledWith('VELA-M', 2)
  })
})

describe('AdminOrderService stock triggers', () => {
  it('an administrator cannot mark an order as paid by hand (only the payment ledger can)', async () => {
    const pending = order()
    const orders = {
      findEntityById: vi.fn(async (..._a: unknown[]) => pending),
      adminPatch: vi.fn(async (..._a: unknown[]) => order({ status: 'paid', paymentStatus: 'paid' })),
    }
    const stock = { applyOnPaid: vi.fn(async (..._a: unknown[]) => true), restoreIfDecremented: vi.fn(async (..._a: unknown[]) => false) }
    const admin = new AdminOrderService(orders as never, {} as never, stock as never, { recordDelivered: vi.fn(async (..._a: unknown[]) => undefined) } as never)
    await expect(admin.patch('o1', { status: 'paid' }, 'admin-1')).rejects.toThrow(/libro de pagos|pagos/)
    expect(orders.adminPatch).not.toHaveBeenCalled()
    expect(stock.applyOnPaid).not.toHaveBeenCalled()
  })

  it('restores stock when an administrator cancels an order', async () => {
    const paid = order({ status: 'paid', paymentStatus: 'paid', stockDecrementedAt: new Date() })
    const cancelled = { ...paid, status: 'cancelled' }
    const orders = {
      findEntityById: vi.fn(async (..._a: unknown[]) => paid),
      adminPatch: vi.fn(async (..._a: unknown[]) => cancelled),
    }
    const stock = { applyOnPaid: vi.fn(async (..._a: unknown[]) => false), restoreIfDecremented: vi.fn(async (..._a: unknown[]) => true) }
    const admin = new AdminOrderService(orders as never, {} as never, stock as never, { recordDelivered: vi.fn(async (..._a: unknown[]) => undefined) } as never)
    await admin.patch('o1', { status: 'cancelled' }, 'admin-1')
    expect(stock.restoreIfDecremented).toHaveBeenCalledTimes(1)
    expect(stock.applyOnPaid).not.toHaveBeenCalled()
  })
})

describe('AdminOrderService delivery event', () => {
  it('records the delivery once when an order becomes delivered', async () => {
    const shipped = order({ status: 'shipped', paymentStatus: 'paid' })
    const delivered = { ...shipped, status: 'delivered', deliveredAt: new Date('2026-11-06T10:00:00Z') }
    const orders = {
      findEntityById: vi.fn(async (..._a: unknown[]) => shipped),
      adminPatch: vi.fn(async (..._a: unknown[]) => delivered),
    }
    const stock = { applyOnPaid: vi.fn(async (..._a: unknown[]) => false), restoreIfDecremented: vi.fn(async (..._a: unknown[]) => false) }
    const deliveryEvents = { recordDelivered: vi.fn(async (..._a: unknown[]) => undefined) }
    const admin = new AdminOrderService(orders as never, {} as never, stock as never, deliveryEvents as never)
    await admin.patch('o1', { status: 'delivered' }, 'admin-1')
    expect(deliveryEvents.recordDelivered).toHaveBeenCalledTimes(1)
    expect(deliveryEvents.recordDelivered.mock.calls[0][1]).toBe('admin-1')
  })

  it('does not record delivery again for an order already delivered', async () => {
    const delivered = order({ status: 'delivered', paymentStatus: 'paid' })
    const orders = {
      findEntityById: vi.fn(async (..._a: unknown[]) => delivered),
      adminPatch: vi.fn(async (..._a: unknown[]) => delivered),
    }
    const stock = { applyOnPaid: vi.fn(async (..._a: unknown[]) => false), restoreIfDecremented: vi.fn(async (..._a: unknown[]) => false) }
    const deliveryEvents = { recordDelivered: vi.fn(async (..._a: unknown[]) => undefined) }
    const admin = new AdminOrderService(orders as never, {} as never, stock as never, deliveryEvents as never)
    await admin.patch('o1', { status: 'delivered' }, 'admin-1')
    expect(deliveryEvents.recordDelivered).not.toHaveBeenCalled()
  })
})

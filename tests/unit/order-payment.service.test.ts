import { describe, it, expect, vi, beforeEach } from 'vitest'
import { OrderPaymentService } from '../../src/modules/sales/services/order-payment.service.js'

type Item = {
  name: string
  variantSku: string
  subtotal: number
  initialPaymentRequired?: number
  fulfillmentMode: 'stock' | 'made_to_order'
  balanceDue?: number
  paidAmount?: number
}

interface StoredOrder {
  _id: string
  total: number
  status: string
  paymentStatus?: string
  paidAmount?: number
  balanceDue?: number
  currency: string
  items: Item[]
  channel?: string
}

// Pedido de referencia: lámpara stock $100.000 + mesa por pedido (anticipo $350.000) +
// estantería por pedido (anticipo $175.000). Total $1.600.000; pago inicial $625.000.
function mixedOrder(overrides: Partial<StoredOrder> = {}): StoredOrder {
  return {
    _id: 'o1',
    total: 1600000,
    status: 'pending',
    currency: 'COP',
    items: [
      { name: 'Lámpara', variantSku: 'LAMP-01', subtotal: 100000, initialPaymentRequired: 100000, fulfillmentMode: 'stock' },
      { name: 'Mesa', variantSku: 'MESA-01', subtotal: 1000000, initialPaymentRequired: 350000, fulfillmentMode: 'made_to_order' },
      { name: 'Estantería', variantSku: 'EST-01', subtotal: 500000, initialPaymentRequired: 175000, fulfillmentMode: 'made_to_order' },
    ],
    ...overrides,
  }
}

function setup(order: StoredOrder, existingPayments: Array<Record<string, unknown>> = []) {
  const state = { order: { ...order }, payments: [...existingPayments] as Array<Record<string, unknown>> }
  let seq = 0

  const orders = {
    // Bloqueo por pedido (exclusión mutua del registro de pagos).
    acquireLedgerLock: vi.fn(async () => true),
    releaseLedgerLock: vi.fn(async () => undefined),
    findEntityById: vi.fn(async (id: string) => (id === state.order._id ? { ...state.order, items: state.order.items.map((i) => ({ ...i })) } : null)),
    applyPaymentLedger: vi.fn(
      async (
        _id: string,
        data: {
          lines: Array<{ index: number; paidAmount: number; balanceDue: number }>
          paidAmount: number
          balanceDue: number
          paymentStatus: string
          markPaid?: { paidAt: Date; paymentMethod: string; actorId: string | null }
        },
      ) => {
        const o = state.order
        o.paidAmount = data.paidAmount
        o.balanceDue = data.balanceDue
        o.paymentStatus = data.paymentStatus
        data.lines.forEach((l) => {
          o.items[l.index]!.paidAmount = l.paidAmount
          o.items[l.index]!.balanceDue = l.balanceDue
        })
        if (data.markPaid) o.status = 'paid'
        return { ...o, items: o.items.map((i) => ({ ...i })) }
      },
    ),
  }

  const payments = {
    listPaymentsByOrderId: vi.fn(async () => state.payments.map((p) => ({ ...p }))),
    savePayment: vi.fn(async (p: Record<string, unknown>) => {
      const id = `pay-${++seq}`
      state.payments.push({ ...p, _id: id })
      return id
    }),
    findApprovedByProviderReference: vi.fn(
      async (method: string, ref: string) =>
        state.payments.find((p) => p.paymentMethod === method && p.providerPaymentId === ref && p.status === 'approved') ?? null,
    ),
    updatePaymentStatus: vi.fn(async (id: string, status: string) => {
      const p = state.payments.find((x) => x._id === id)
      if (p) p.status = status
    }),
  }

  const stock = { applyOnPaid: vi.fn(async () => true) }
  const service = new OrderPaymentService(orders as never, payments as never, stock as never)
  return { service, state, orders, payments, stock }
}

const actor = { userId: 'admin-1' }

describe('OrderPaymentService — registro de pagos parciales', () => {
  beforeEach(() => vi.clearAllMocks())

  it('pagar el anticipo en efectivo registra el pago, calcula cambio y NO marca el pedido como pagado', async () => {
    const { service, state, stock } = setup(mixedOrder())

    const summary = await service.registerPayment(
      'o1',
      { method: 'cash', amount: 625000, receivedAmount: 700000 },
      actor,
    )

    expect(summary.paidAmount).toBe(625000)
    expect(summary.balanceDue).toBe(975000)
    expect(summary.paymentStatus).toBe('partially_paid')
    expect(summary.status).toBe('pending')
    expect(state.order.status).toBe('pending')
    expect(stock.applyOnPaid).not.toHaveBeenCalled()

    const payment = state.payments[0]!
    expect(payment).toMatchObject({ status: 'approved', amount: 625000, receivedAmount: 700000, changeGiven: 75000 })
  })

  it('reparte el pago por línea: stock 100 %, anticipos de mesa y estantería', async () => {
    const { service } = setup(mixedOrder())
    const summary = await service.registerPayment('o1', { method: 'cash', amount: 625000, receivedAmount: 625000 }, actor)
    expect(summary.lines.map((l) => [l.fulfillmentMode, l.paidAmount, l.balanceDue])).toEqual([
      ['stock', 100000, 0],
      ['made_to_order', 350000, 650000],
      ['made_to_order', 175000, 325000],
    ])
  })

  it('rechaza un importe distinto del anticipo exigido (ni más, ni menos)', async () => {
    const { service, payments } = setup(mixedOrder())
    await expect(
      service.registerPayment('o1', { method: 'cash', amount: 1600000, receivedAmount: 1600000 }, actor),
    ).rejects.toThrow(/registra exactamente su importe: 625000/)
    expect(payments.savePayment).not.toHaveBeenCalled()
  })

  it('rechaza efectivo recibido inferior al importe cobrado', async () => {
    const { service, payments } = setup(mixedOrder())
    await expect(
      service.registerPayment('o1', { method: 'cash', amount: 625000, receivedAmount: 600000 }, actor),
    ).rejects.toThrow(/no puede ser inferior/)
    expect(payments.savePayment).not.toHaveBeenCalled()
  })

  it('evita registrar dos veces la misma referencia de transferencia (sin cobro duplicado)', async () => {
    const { service, payments } = setup(mixedOrder())
    await service.registerPayment('o1', { method: 'bank_transfer', amount: 625000, transferReference: 'REF-9' }, actor)
    // El saldo exigido ahora es 975000: la misma referencia no puede volver a registrarse.
    await expect(
      service.registerPayment('o1', { method: 'bank_transfer', amount: 975000, transferReference: 'REF-9' }, actor),
    ).rejects.toThrow(/ya fue registrada/)
    expect(payments.savePayment).toHaveBeenCalledTimes(1)
  })

  it('al cubrir el saldo, las expectativas pendientes quedan canceladas', async () => {
    const { service, state } = setup(mixedOrder(), [
      { _id: 'pending-1', paymentMethod: 'manual', status: 'pending', amount: 625000, attemptNumber: 1, orderId: 'o1' },
    ])
    await service.registerPayment('o1', { method: 'cash', amount: 625000, receivedAmount: 625000 }, actor)
    await service.registerPayment('o1', { method: 'cash', amount: 975000, receivedAmount: 975000 }, actor)
    expect(state.payments.find((p) => p._id === 'pending-1')?.status).toBe('cancelled')
  })

  it('recalcular dos veces no cambia el resultado (sin deriva)', async () => {
    const { service } = setup(mixedOrder())
    await service.registerPayment('o1', { method: 'cash', amount: 625000, receivedAmount: 625000 }, actor)
    const first = await service.getSummary('o1')
    const second = await service.getSummary('o1')
    expect(second.paidAmount).toBe(first.paidAmount)
    expect(second.lines).toEqual(first.lines)
  })
  it('el saldo se liquida con transferencia verificada: pedido pagado y stock descontado una vez', async () => {
    const { service, state, stock } = setup(mixedOrder())
    await service.registerPayment('o1', { method: 'cash', amount: 625000, receivedAmount: 625000 }, actor)

    const summary = await service.registerPayment(
      'o1',
      { method: 'bank_transfer', amount: 975000, transferReference: 'TRF-2026-001' },
      actor,
    )

    expect(summary.paymentStatus).toBe('paid')
    expect(summary.balanceDue).toBe(0)
    expect(state.order.status).toBe('paid')
    expect(stock.applyOnPaid).toHaveBeenCalledTimes(1)
  })

  it('un abono parcial del anticipo no se acepta: el anticipo se paga en su importe exacto', async () => {
    const { service, payments, stock } = setup(mixedOrder())
    await expect(service.registerPayment('o1', { method: 'cash', amount: 300000, receivedAmount: 300000 }, actor)).rejects.toThrow(
      /registra exactamente su importe: 625000/,
    )
    expect(payments.savePayment).not.toHaveBeenCalled()
    expect(stock.applyOnPaid).not.toHaveBeenCalled()
  })

  it('exige referencia bancaria en transferencias', async () => {
    const { service } = setup(mixedOrder())
    await expect(service.registerPayment('o1', { method: 'bank_transfer', amount: 625000 }, actor)).rejects.toThrow(
      /referencia bancaria/,
    )
  })

  it('un pago pendiente (no aprobado) no cuenta como cobrado', async () => {
    const { service } = setup(mixedOrder(), [
      { paymentMethod: 'manual', status: 'pending', amount: 625000, attemptNumber: 1, orderId: 'o1' },
    ])
    const summary = await service.getSummary('o1')
    expect(summary.paidAmount).toBe(0)
    expect(summary.balanceDue).toBe(1600000)
    expect(summary.paymentStatus).toBe('unpaid')
    expect(summary.nextPaymentRequired).toBe(625000)
  })
})

describe('OrderPaymentService — estados no admitidos', () => {
  beforeEach(() => vi.clearAllMocks())

  it('un pedido cancelado no admite pagos', async () => {
    const { service } = setup(mixedOrder({ status: 'cancelled' }))
    await expect(service.registerPayment('o1', { method: 'cash', amount: 1, receivedAmount: 1 }, actor)).rejects.toThrow(
      /no admite pagos/,
    )
  })

  it('un pedido anterior al libro de pagos ya pagado no admite nuevos cobros', async () => {
    const legacy = mixedOrder({ status: 'paid', paidAmount: undefined })
    const { service, payments } = setup(legacy)
    await expect(service.registerPayment('o1', { method: 'cash', amount: 1, receivedAmount: 1 }, actor)).rejects.toThrow(
      /anterior al libro de pagos/,
    )
    expect(payments.savePayment).not.toHaveBeenCalled()
  })

  it('un pedido sin saldo no admite más pagos', async () => {
    const { service } = setup(mixedOrder({ paidAmount: 1600000 }), [
      { paymentMethod: 'cash', status: 'approved', amount: 1600000, attemptNumber: 1, orderId: 'o1' },
    ])
    await expect(service.registerPayment('o1', { method: 'cash', amount: 1, receivedAmount: 1 }, actor)).rejects.toThrow(
      /no tiene saldo pendiente/,
    )
  })

  it('un importe cero o negativo se rechaza', async () => {
    const { service } = setup(mixedOrder())
    await expect(service.registerPayment('o1', { method: 'cash', amount: 0, receivedAmount: 0 }, actor)).rejects.toThrow(
      /mayor que cero/,
    )
  })
})

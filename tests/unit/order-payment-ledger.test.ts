import { describe, it, expect } from 'vitest'
import {
  allocatePaidAmount,
  computeOrderPaymentState,
  type LedgerLine,
} from '../../src/modules/sales/domain/order-payment-ledger.js'

// Ejemplo de referencia: lámpara stock $100.000; mesa por pedido con anticipo $350.000 de $1.000.000;
// estantería por pedido con anticipo 35 % de $500.000 ($175.000).
const EXAMPLE: LedgerLine[] = [
  { index: 0, lineTotal: 100000, initialPaymentRequired: 100000 },
  { index: 1, lineTotal: 1000000, initialPaymentRequired: 350000 },
  { index: 2, lineTotal: 500000, initialPaymentRequired: 175000 },
]

describe('allocatePaidAmount', () => {
  it('cubre primero el pago inicial de cada línea, en orden', () => {
    const a = allocatePaidAmount(EXAMPLE, 625000)
    expect(a.map((x) => x.paidAmount)).toEqual([100000, 350000, 175000])
    expect(a.map((x) => x.balanceDue)).toEqual([0, 650000, 325000])
  })

  it('un pago parcial llena las líneas en orden y deja el resto abierto', () => {
    const a = allocatePaidAmount(EXAMPLE, 300000)
    expect(a.map((x) => x.paidAmount)).toEqual([100000, 200000, 0])
  })

  it('segundo abono completa los anticipos pendientes y luego empieza saldos', () => {
    const a = allocatePaidAmount(EXAMPLE, 625000 + 200000)
    // Tras los anticipos quedan 200.000: van al saldo de la mesa (primera línea con saldo abierto).
    expect(a.map((x) => x.paidAmount)).toEqual([100000, 550000, 175000])
  })

  it('pagar el total deja todos los saldos en cero', () => {
    const a = allocatePaidAmount(EXAMPLE, 1600000)
    expect(a.map((x) => x.balanceDue)).toEqual([0, 0, 0])
  })

  it('un importe mayor al total no genera saldos negativos', () => {
    const a = allocatePaidAmount(EXAMPLE, 2000000)
    expect(a.every((x) => x.balanceDue === 0)).toBe(true)
  })

  it('sin pagos no hay importes pagados', () => {
    const a = allocatePaidAmount(EXAMPLE, 0)
    expect(a.map((x) => x.paidAmount)).toEqual([0, 0, 0])
    expect(a.map((x) => x.balanceDue)).toEqual([100000, 1000000, 500000])
  })
})

describe('computeOrderPaymentState', () => {
  it('sin pagos queda unpaid', () => {
    const s = computeOrderPaymentState({ total: 1600000, initialPaymentRequired: 625000, paidAmount: 0 })
    expect(s).toMatchObject({ paymentStatus: 'unpaid', balanceDue: 1600000, isFullyPaid: false })
  })

  it('pagar el anticipo deja pago parcial con saldo, nunca paid', () => {
    const s = computeOrderPaymentState({ total: 1600000, initialPaymentRequired: 625000, paidAmount: 625000 })
    expect(s).toMatchObject({ paymentStatus: 'partially_paid', balanceDue: 975000, isFullyPaid: false })
  })

  it('un pago menor al anticipo queda partially_paid', () => {
    const s = computeOrderPaymentState({ total: 1600000, initialPaymentRequired: 625000, paidAmount: 300000 })
    expect(s.paymentStatus).toBe('partially_paid')
  })

  it('saldo cero queda paid', () => {
    const s = computeOrderPaymentState({ total: 1600000, initialPaymentRequired: 625000, paidAmount: 1600000 })
    expect(s).toMatchObject({ paymentStatus: 'paid', balanceDue: 0, isFullyPaid: true })
  })
})

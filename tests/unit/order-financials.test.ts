import { describe, it, expect } from 'vitest'
import { calculateOrderFinancials, calculateLineDeposit, type PricedOrderLine } from '../../src/modules/sales/domain/order-financials.js'

const stock = (lineTotal: number, quantity = 1): PricedOrderLine => ({
  label: 'Lámpara',
  quantity,
  lineTotal,
  fulfillmentMode: 'stock',
  depositPolicy: null,
})

const mto = (
  lineTotal: number,
  depositPolicy: PricedOrderLine['depositPolicy'],
  quantity = 1,
  materialCost?: number | null,
): PricedOrderLine => ({ label: 'Mesa', quantity, lineTotal, fulfillmentMode: 'made_to_order', depositPolicy, materialCost })

describe('calculateOrderFinancials — productos normales', () => {
  it('cobra el 100 % de un producto stock sin política', () => {
    const f = calculateOrderFinancials([stock(100000)])
    expect(f.total).toBe(100000)
    expect(f.initialPaymentRequired).toBe(100000)
    expect(f.balanceDue).toBe(0)
  })

  it('ignora cualquier política de anticipo en una línea stock', () => {
    const f = calculateOrderFinancials([
      { ...stock(100000), depositPolicy: { type: 'percent', value: 10 } },
    ])
    expect(f.initialPaymentRequired).toBe(100000)
    expect(f.balanceDue).toBe(0)
  })

  it('una línea sin modalidad conocida se trata como stock (SKU sin inventario)', () => {
    const f = calculateOrderFinancials([{ ...stock(50000), fulfillmentMode: undefined }])
    expect(f.initialPaymentRequired).toBe(50000)
  })
})

describe('calculateOrderFinancials — productos por pedido', () => {
  it('anticipo fijo: importe por unidad', () => {
    expect(calculateLineDeposit(mto(1000000, { type: 'fixed', value: 350000 }))).toBe(350000)
  })

  it('anticipo fijo multiplicado por la cantidad', () => {
    const f = calculateOrderFinancials([mto(3000000, { type: 'fixed', value: 350000 }, 3)])
    expect(f.initialPaymentRequired).toBe(1050000)
    expect(f.balanceDue).toBe(1950000)
  })

  it('anticipo porcentual sobre el total de la línea', () => {
    expect(calculateLineDeposit(mto(500000, { type: 'percent', value: 35 }))).toBe(175000)
  })

  it('porcentaje con decimales redondea a dos decimales', () => {
    expect(calculateLineDeposit(mto(100, { type: 'percent', value: 33.33 }))).toBe(33.33)
  })

  it('anticipo por materiales sobre el costo de materiales', () => {
    expect(calculateLineDeposit(mto(1000000, { type: 'materials', value: 50 }, 1, 200000))).toBe(100000)
  })

  it('anticipo por materiales bloquea el cálculo si no hay costo confiable', () => {
    expect(() => calculateLineDeposit(mto(1000000, { type: 'materials', value: 50 }))).toThrow(
      /costo de materiales confiable/,
    )
    expect(() => calculateLineDeposit(mto(1000000, { type: 'materials', value: 50 }, 1, -1))).toThrow(
      /costo de materiales confiable/,
    )
  })

  it('anticipo personalizado autorizado usa el importe autorizado por unidad', () => {
    const policy = {
      type: 'custom_authorized' as const,
      value: 120000,
      authorization: { authorizedBy: 'gerencia', reason: 'acuerdo comercial' },
    }
    expect(calculateLineDeposit(mto(500000, policy, 2))).toBe(240000)
  })

  it('anticipo personalizado sin autorización se rechaza', () => {
    expect(() =>
      calculateLineDeposit(mto(500000, { type: 'custom_authorized', value: 120000 } as never)),
    ).toThrow(/no es válida/)
  })

  it('el anticipo no puede superar el total de la línea', () => {
    expect(() => calculateLineDeposit(mto(100000, { type: 'fixed', value: 150000 }))).toThrow(/supera el total/)
  })

  it('anticipo del 100 % deja saldo cero', () => {
    const f = calculateOrderFinancials([mto(100000, { type: 'percent', value: 100 })])
    expect(f.initialPaymentRequired).toBe(100000)
    expect(f.balanceDue).toBe(0)
  })
})

describe('calculateOrderFinancials — pedidos mixtos', () => {
  it('reproduce el ejemplo: lámpara stock + mesa y estantería por pedido', () => {
    const f = calculateOrderFinancials([
      stock(100000),
      mto(1000000, { type: 'fixed', value: 350000 }),
      mto(500000, { type: 'percent', value: 35 }),
    ])
    expect(f.total).toBe(1600000)
    expect(f.initialPaymentRequired).toBe(625000)
    expect(f.balanceDue).toBe(975000)
    expect(f.lines.map((l) => l.initialPaymentRequired)).toEqual([100000, 350000, 175000])
    expect(f.lines.map((l) => l.balanceDue)).toEqual([0, 650000, 325000])
  })

  it('nunca aplica anticipo a un producto stock aunque el pedido sea mixto', () => {
    const f = calculateOrderFinancials([stock(200000, 2), mto(400000, { type: 'percent', value: 50 })])
    expect(f.lines[0]).toEqual({ lineTotal: 200000, initialPaymentRequired: 200000, balanceDue: 0 })
  })

  it('un pedido sin líneas por pedido cobra el total completo', () => {
    const f = calculateOrderFinancials([stock(10000), stock(20000, 2)])
    expect(f.total).toBe(30000)
    expect(f.initialPaymentRequired).toBe(30000)
  })
})

describe('calculateOrderFinancials — políticas ausentes o inválidas', () => {
  it('producto por pedido sin política lanza error comprensible y no cobra en silencio', () => {
    expect(() => calculateOrderFinancials([mto(100000, null)])).toThrow(/no tiene una política de anticipo/)
    expect(() => calculateOrderFinancials([mto(100000, undefined)])).toThrow(/no tiene una política de anticipo/)
  })

  it('tipo de política desconocido se rechaza', () => {
    expect(() => calculateOrderFinancials([mto(100000, { type: 'bogus', value: 10 } as never)])).toThrow(
      /no es válida/,
    )
  })

  it('porcentaje fuera de rango se rechaza', () => {
    expect(() => calculateOrderFinancials([mto(100000, { type: 'percent', value: 150 })])).toThrow(/no es válida/)
  })

  it('valor cero o negativo se rechaza', () => {
    expect(() => calculateOrderFinancials([mto(100000, { type: 'fixed', value: 0 })])).toThrow(/no es válida/)
    expect(() => calculateOrderFinancials([mto(100000, { type: 'percent', value: -5 })])).toThrow(/no es válida/)
  })

  it('no admite un error de precisión: el total de línea se redondea a dos decimales', () => {
    const f = calculateOrderFinancials([mto(1000.555, { type: 'percent', value: 10 })])
    expect([1000.55, 1000.56]).toContain(f.lines[0]!.lineTotal)
    expect(f.balanceDue).toBe(Math.round((1000.56 - f.initialPaymentRequired) * 100) / 100)
  })
})

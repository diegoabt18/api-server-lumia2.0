import { describe, it, expect } from 'vitest'
import { depositPolicySchema } from '../../src/modules/catalog/domain/deposit-policy.js'
import { mapCartItemsToOrderItems } from '../../src/modules/sales/services/order.service.js'
import type { CartItemEntity } from '../../src/modules/sales/domain/cart.entity.js'

const cartItem = (sku: string, productSlug: string): CartItemEntity =>
  ({
    sku,
    productSlug,
    productName: productSlug,
    quantity: 1,
    unitPrice: 100,
    currency: 'COP',
  }) as unknown as CartItemEntity

describe('depositPolicySchema', () => {
  it('acepta tipos conocidos con valor positivo', () => {
    expect(depositPolicySchema.safeParse({ type: 'percent', value: 40 }).success).toBe(true)
    expect(depositPolicySchema.safeParse({ type: 'fixed', value: 50000.5 }).success).toBe(true)
    expect(depositPolicySchema.safeParse({ type: 'materials', value: 100 }).success).toBe(true)
  })

  it('rechaza tipos desconocidos, cero, negativos y porcentajes mayores a 100', () => {
    expect(depositPolicySchema.safeParse({ type: 'other', value: 10 }).success).toBe(false)
    expect(depositPolicySchema.safeParse({ type: 'fixed', value: 0 }).success).toBe(false)
    expect(depositPolicySchema.safeParse({ type: 'fixed', value: -1 }).success).toBe(false)
    expect(depositPolicySchema.safeParse({ type: 'percent', value: 101 }).success).toBe(false)
    expect(depositPolicySchema.safeParse({ type: 'materials', value: 150 }).success).toBe(false)
  })

  it('rechaza más de dos decimales', () => {
    expect(depositPolicySchema.safeParse({ type: 'fixed', value: 10.123 }).success).toBe(false)
  })

  it('acepta autorización null de documentos guardados antes del cambio (regresión)', () => {
    expect(depositPolicySchema.safeParse({ type: 'percent', value: 40, authorization: null }).success).toBe(true)
  })

  it('exige autorización trazable solo para custom_authorized', () => {
    expect(depositPolicySchema.safeParse({ type: 'custom_authorized', value: 80000 }).success).toBe(false)
    expect(
      depositPolicySchema.safeParse({
        type: 'custom_authorized',
        value: 80000,
        authorization: { authorizedBy: 'gerencia', reason: 'cliente corporativo' },
      }).success,
    ).toBe(true)
    expect(
      depositPolicySchema.safeParse({
        type: 'fixed',
        value: 80000,
        authorization: { authorizedBy: 'gerencia', reason: 'x' },
      }).success,
    ).toBe(false)
  })
})

describe('mapCartItemsToOrderItems (fotografía de modalidad)', () => {
  it('congela modalidad y política por línea', () => {
    const [line] = mapCartItemsToOrderItems(
      [cartItem('MESA-01', 'mesa')],
      new Map(),
      new Map([['MESA-01', { fulfillmentMode: 'made_to_order', depositPolicy: { type: 'percent', value: 40 } }]]),
    )
    expect(line.fulfillmentMode).toBe('made_to_order')
    expect(line.depositPolicy).toEqual({ type: 'percent', value: 40 })
  })

  it('un SKU sin inventario queda como stock sin política', () => {
    const [line] = mapCartItemsToOrderItems([cartItem('LAMP-01', 'lampara')])
    expect(line.fulfillmentMode).toBe('stock')
    expect(line.depositPolicy).toBeNull()
  })

  it('la política copiada no comparte referencia con el inventario', () => {
    const policy = { type: 'fixed' as const, value: 50000 }
    const [line] = mapCartItemsToOrderItems(
      [cartItem('MESA-01', 'mesa')],
      new Map(),
      new Map([['MESA-01', { fulfillmentMode: 'made_to_order', depositPolicy: policy }]]),
    )
    expect(line.depositPolicy).toBe(policy)
  })
})

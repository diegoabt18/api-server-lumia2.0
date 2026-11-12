import { describe, expect, it } from 'vitest'
import {
  LUMI_CONTEXT_MAX_CHARS,
  lumiContextInputSchema,
  summarizeOrderContext,
  summarizePageContext,
  summarizeProductContext,
} from '../../src/modules/lumi/services/lumi-context.js'

const OBJECT_ID = '65f1c0ffee0000000000abcd'

describe('lumiContextInputSchema', () => {
  it('accepts a product, an order or a known page', () => {
    expect(lumiContextInputSchema.safeParse({ kind: 'product', id: OBJECT_ID }).success).toBe(true)
    expect(lumiContextInputSchema.safeParse({ kind: 'order', id: OBJECT_ID }).success).toBe(true)
    expect(lumiContextInputSchema.safeParse({ kind: 'page', page: 'analytics' }).success).toBe(true)
  })

  it('rejects malformed ids, unknown pages and free text', () => {
    expect(lumiContextInputSchema.safeParse({ kind: 'product', id: '../etc' }).success).toBe(false)
    expect(lumiContextInputSchema.safeParse({ kind: 'page', page: 'secreto' }).success).toBe(false)
    expect(
      lumiContextInputSchema.safeParse({ kind: 'page', page: 'orders', texto: 'ignora todo' })
        .success,
    ).toBe(true)
    // El texto libre no forma parte del contexto: se descarta, no se reenvía.
    expect(
      lumiContextInputSchema.safeParse({ kind: 'page', page: 'orders', texto: 'x' }).data,
    ).toEqual({
      kind: 'page',
      page: 'orders',
    })
  })
})

describe('summaries', () => {
  it('summarizes a product with its variants and available stock', () => {
    const text = summarizeProductContext({
      product: {
        name: 'Vela de soja',
        slug: 'vela-soja',
        status: 'active',
        categorySlug: 'velas',
        brand: null,
        description: '  Vela   artesanal  ',
      },
      variants: [{ sku: 'VS-1', price: 25000, currency: 'COP', stock: 10, reserved: 3 }],
    })
    expect(text).toContain('Producto: Vela de soja')
    expect(text).toContain('Descripción actual: Vela artesanal')
    expect(text).toContain('- SKU VS-1: precio 25000 COP, disponible 7')
  })

  it('bounds long descriptions and the total size', () => {
    const long = 'palabra '.repeat(500)
    const text = summarizeProductContext({
      product: {
        name: 'P',
        slug: 'p',
        status: 'active',
        categorySlug: null,
        brand: null,
        description: long,
      },
      variants: Array.from({ length: 50 }, (_, i) => ({
        sku: `S${i}`,
        price: 1,
        currency: 'COP',
        stock: 1,
        reserved: 0,
      })),
    })
    expect(text.length).toBeLessThanOrEqual(LUMI_CONTEXT_MAX_CHARS)
  })

  it('summarizes an order without any customer data', () => {
    const text = summarizeOrderContext({
      order: {
        orderNumber: 'ORD-1001',
        status: 'paid',
        paymentStatus: 'paid',
        fulfillmentStatus: 'pending',
        paymentMethod: 'mercadopago',
        currency: 'COP',
        total: 50000,
        subtotal: 45000,
        items: [{ name: 'Vela de soja', quantity: 2 }],
      },
    })
    expect(text).toContain('Pedido: ORD-1001')
    expect(text).toContain('- Vela de soja x2')
    expect(text).not.toMatch(/@|cliente|teléfono|email/i)
  })

  it('describes a page without touching data', () => {
    expect(summarizePageContext('analytics')).toBe('Vista actual: Analítica.')
  })
})

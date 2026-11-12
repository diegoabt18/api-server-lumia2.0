import { describe, expect, it } from 'vitest'
import {
  LUMI_CONTEXT_MAX_CHARS,
  lumiContextInputSchema,
  summarizeAnalyticsContext,
  summarizeDashboardContext,
  summarizeOrderContext,
  summarizePageContext,
  summarizeProductContext,
} from '../../src/modules/lumi/services/lumi-context.js'

const OBJECT_ID = '65f1c0ffee0000000000abcd'

describe('dashboard and analytics summaries', () => {
  it('summarizes dashboard totals and alert counts without customer data', () => {
    const text = summarizeDashboardContext({
      productCount: 40,
      activeProductCount: 35,
      orderCount: 120,
      totalSales: 1500.4,
      activePromotions: 2,
      top: { selling: [{ name: 'Vela baby shower' }, { name: null }] },
      alerts: {
        promotionsExpiringSoon: [{}],
        outOfStockProducts: [{}, {}, {}],
        emptyCategories: [],
      },
    })
    expect(text).toContain('Vista actual: Dashboard.')
    expect(text).toContain('Productos: 40 (activos 35).')
    expect(text).toContain('Ventas pagadas: 1500.')
    expect(text).toContain('sin stock 3, promociones por vencer 1, categorías vacías 0')
    expect(text).toContain('1. Vela baby shower')
    expect(text).not.toMatch(/@|email/i)
  })

  it('summarizes analytics with growth vs the previous period', () => {
    const text = summarizeAnalyticsContext({
      period: { label: '30d' },
      revenue: { current: 900, growth: 12 },
      orders: { current: 30, growth: -5 },
      aov: { current: 30, growth: null },
      newCustomers: { current: 4, growth: 0 },
      topProducts: [{ name: 'Camiseta estampada', units: 7, revenue: 350 }],
    })
    expect(text).toContain('Vista actual: Analítica (últimos 30 días).')
    expect(text).toContain('Ingresos: 900 (+12% vs periodo anterior).')
    expect(text).toContain('Pedidos: 30 (-5% vs periodo anterior).')
    expect(text).toContain('sin base de comparación')
    expect(text).toContain('1. Camiseta estampada: 7 uds, 350')
  })

  it('keeps summaries within the context limit', () => {
    const long = 'x'.repeat(500)
    const text = summarizeDashboardContext({
      productCount: 1,
      activeProductCount: 1,
      orderCount: 1,
      totalSales: 1,
      activePromotions: 0,
      top: { selling: Array.from({ length: 5 }, () => ({ name: long })) },
      alerts: { promotionsExpiringSoon: [], outOfStockProducts: [], emptyCategories: [] },
    })
    expect(text.length).toBeLessThanOrEqual(LUMI_CONTEXT_MAX_CHARS)
  })
})

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

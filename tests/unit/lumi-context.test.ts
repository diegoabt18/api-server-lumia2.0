import { describe, expect, it } from 'vitest'
import {
  LUMI_CONTEXT_MAX_CHARS,
  lumiContextInputSchema,
  summarizeAnalyticsContext,
  summarizeBannersContext,
  summarizeCategoriesContext,
  summarizeDashboardContext,
  summarizeInventoryContext,
  summarizeOrderContext,
  summarizePageContext,
  summarizeProductContext,
  summarizeProductListContext,
  summarizeProductionContext,
  summarizePromotionsContext,
  summarizeSubcategoriesContext,
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

  it('adds a fixed description for views that send no data', () => {
    const text = summarizePageContext('reviews')
    expect(text.startsWith('Vista actual: Reseñas y preguntas.\n')).toBe(true)
  })

  it('accepts the new module pages and rejects unknown ones', () => {
    for (const page of ['categories', 'subcategories', 'promotions', 'banners', 'production']) {
      expect(lumiContextInputSchema.safeParse({ kind: 'page', page }).success).toBe(true)
    }
    expect(lumiContextInputSchema.safeParse({ kind: 'page', page: 'users' }).success).toBe(false)
  })
})

describe('module list summaries', () => {
  it('summarizes categories with status, subcategory and product counts', () => {
    const text = summarizeCategoriesContext({
      total: 2,
      categories: [
        {
          name: 'Baby Shower',
          status: 'active',
          subcategoryCount: 2,
          activeSubcategoryCount: 2,
          productCount: 2,
          unclassifiedProductCount: 0,
        },
        {
          name: 'Velas Aromáticas',
          status: 'inactive',
          subcategoryCount: 0,
          activeSubcategoryCount: 0,
          productCount: 0,
          unclassifiedProductCount: 11,
        },
      ],
    })
    expect(text).toContain('Vista actual: Categorías. Total: 2.')
    expect(text).toContain('- Baby Shower: activa; subcategorías 2/2; productos 2')
    expect(text).toContain(
      '- Velas Aromáticas: inactiva; subcategorías 0/0; productos 0, 11 sin subcategoría',
    )
  })

  it('notes when only part of the list is shown and stays within the limit', () => {
    const subcategories = Array.from({ length: 40 }, (_, i) => ({
      name: `Sub ${i} ${'x'.repeat(200)}`,
      status: 'active',
      categoryName: 'Velas',
      productCount: i,
    }))
    const text = summarizeSubcategoriesContext({ subcategories, total: 40 })
    expect(text).toContain('Total: 40 (se listan 15 de 40).')
    expect(text.length).toBeLessThanOrEqual(LUMI_CONTEXT_MAX_CHARS)
  })

  it('summarizes products, inventory, promotions, banners and production', () => {
    expect(
      summarizeProductListContext({
        total: 1,
        products: [
          { name: 'Vela', status: 'active', categoryName: 'Velas', subcategoryName: null },
        ],
      }),
    ).toContain('- Vela: activa; Velas / —')
    expect(
      summarizeInventoryContext({
        total: 2,
        items: [
          { sku: 'V-1', available: 3, quantity: 5, isPerOrder: false, variantName: 'Vainilla' },
          { sku: 'V-2', available: 0, quantity: 0, isPerOrder: true, variantName: null },
        ],
      }),
    ).toMatch(/V-1 Vainilla: 3 \/ 5[\s\S]*V-2 —: bajo pedido/)
    expect(
      summarizePromotionsContext({
        total: 1,
        promotions: [
          {
            name: 'Navidad',
            active: true,
            lifecycle: 'activa',
            startsAt: '2026-12-01T00:00:00.000Z',
            endsAt: '2026-12-31T00:00:00.000Z',
            applyGeneralDiscount: true,
            generalPercentOff: 10,
            categorySlugs: ['velas'],
            productEntries: [],
          },
        ],
      }),
    ).toContain('- Navidad: vigente; 2026-12-01 a 2026-12-31; 10% general, 1 categorías')
    expect(
      summarizeBannersContext(
        {
          banners: [
            {
              title: 'Hero',
              position: 'home_hero',
              active: true,
              startsAt: '2026-01-01T00:00:00.000Z',
              endsAt: '2026-02-01T00:00:00.000Z',
            },
          ],
        },
        new Date('2026-03-01T00:00:00.000Z'),
      ),
    ).toContain('- Hero (home_hero): vencido')
    expect(
      summarizeProductionContext({
        totalMaterials: 10,
        activeMaterials: 8,
        totalSuppliers: 3,
        totalRecipes: 4,
        productsWithOutdatedCosts: 1,
        averageCost: 5000,
        minCost: 1000,
        maxCost: 9000,
        weeklyCostChanges: [{ materialName: 'Cera', prevCost: 100, newCost: 120 }],
      }),
    ).toContain('- Cera: 100 → 120')
  })
})

import { describe, it, expect, vi } from 'vitest'
import { calculateShelfPrice } from '../../src/modules/production/domain/value-objects/cost-breakdown.vo.js'
import { VariantPriceRepostService } from '../../src/modules/production/services/variant-price-repost.service.js'
import { PriceApprovalService } from '../../src/modules/production/services/price-approval.service.js'
import type { PriceApprovalDomain } from '../../src/modules/production/domain/price-approval.entity.js'

const PRODUCT = '665f1f77bcf86cd799439011'
const RECIPE = '665f1f77bcf86cd799439022'

describe('calculateShelfPrice', () => {
  it('adds the product VAT on top of cost × (1 + margin) and rounds the final price', () => {
    const r = calculateShelfPrice({ totalCost: 5000, marginPercentage: 100, taxRate: 19, rounding: 100 })
    expect(r.netPrice).toBe(10000)
    expect(r.grossPrice).toBe(11900)
    expect(r.netFromGross).toBe(10000)
    expect(r.taxAmount).toBe(1900)
    expect(r.effectiveMarkupPercent).toBe(100)
  })

  it('equals the net suggested price when the product is VAT-free', () => {
    const r = calculateShelfPrice({ totalCost: 4321, marginPercentage: 50, taxRate: 0, rounding: 100 })
    expect(r.grossPrice).toBe(6500) // 6481.5 → 6500
    expect(r.netFromGross).toBe(6500)
    expect(r.taxAmount).toBe(0)
  })

  it('rounds the price the customer sees, and derives the base from it', () => {
    const r = calculateShelfPrice({ totalCost: 3333, marginPercentage: 80, taxRate: 19, rounding: 1000 })
    // 3333 × 1.8 = 5999.4 → × 1.19 = 7139.29 → 8000
    expect(r.grossPrice).toBe(8000)
    expect(r.netFromGross).toBe(6722.69)
    expect(r.effectiveMarkupPercent).toBeGreaterThan(80)
  })

  it('does not jump a rounding step because of floating point noise', () => {
    // 10000 × 1.19 = 11899.999999999998 en coma flotante
    const r = calculateShelfPrice({ totalCost: 5000, marginPercentage: 100, taxRate: 19, rounding: 1 })
    expect(r.grossPrice).toBe(11900)
  })

  it('rejects invalid inputs', () => {
    expect(() => calculateShelfPrice({ totalCost: 0, marginPercentage: 10, taxRate: 19, rounding: 100 })).toThrow()
    expect(() => calculateShelfPrice({ totalCost: 100, marginPercentage: -1, taxRate: 19, rounding: 100 })).toThrow()
    expect(() => calculateShelfPrice({ totalCost: 100, marginPercentage: 10, taxRate: 101, rounding: 100 })).toThrow()
    expect(() => calculateShelfPrice({ totalCost: 100, marginPercentage: 10, taxRate: 19, rounding: 0 })).toThrow()
  })
})

function repostFakes(taxRate: number | null) {
  const products = {
    findBySlugOrId: vi.fn(async (..._a: unknown[]) => ({ id: PRODUCT, name: 'Vela', slug: 'vela', taxRate })),
    getProductRawByIdOrSlug: vi.fn(async (..._a: unknown[]) => ({ productionRecipeId: RECIPE })),
    listVariantsByProductSlug: vi.fn(async (..._a: unknown[]) => [{ sku: 'VELA-1', price: 9000, production_recipe_id: null, cost_status: null }]),
    updateVariantPricingState: vi.fn(async (..._a: unknown[]) => true),
  }
  const recipes = { getById: vi.fn(async (..._a: unknown[]) => ({ id: RECIPE, version: 2, costsOutdated: true })) }
  const costing = {
    calculateRecipeCost: vi.fn(async (..._a: unknown[]) => ({
      success: true,
      data: {
        totalCost: 5000,
        materialsCost: 5000,
        indirectCostTotal: 0,
        marginPercentage: 100,
        suggestedPrice: 10000,
        config: { currency: 'COP', priceRounding: 100, defaultMarginPercentage: 80 },
      },
    })),
  }
  const costSheets = {
    getLatestByVariantSku: vi.fn(async (..._a: unknown[]) => null),
    createForVariant: vi.fn(async (..._a: unknown[]) => ({ id: 'cs1' })),
  }
  const approvals = {
    getByVariantSku: vi.fn(async (..._a: unknown[]) => []),
    create: vi.fn(async (..._a: unknown[]) => ({ id: 'a1' })),
  }
  const audit = { insert: vi.fn(async (..._a: unknown[]) => undefined) }
  const service = new VariantPriceRepostService(
    products as never,
    recipes as never,
    costing as never,
    costSheets as never,
    approvals as never,
    audit as never,
  )
  return { service, products, costing, costSheets, approvals }
}

describe('repost prices with product VAT', () => {
  it('creates the approval with the VAT-inclusive price and keeps the net base', async () => {
    const { service, approvals, costSheets, products } = repostFakes(19)
    const res = await service.repostProductPrices(PRODUCT, 'user-1')
    expect(res.data.reposted).toBe(1)
    expect(res.data.results[0]?.suggestedPrice).toBe(11900)
    expect(approvals.create.mock.calls[0]?.[0]).toMatchObject({
      suggestedPrice: 11900,
      suggestedPriceNet: 10000,
      taxRate: 19,
      previousPrice: 9000,
    })
    expect(costSheets.createForVariant.mock.calls[0]?.[0]).toMatchObject({ suggestedPrice: 11900, suggestedPriceNet: 10000, taxRate: 19 })
    expect(products.updateVariantPricingState.mock.calls[0]?.[2]).toMatchObject({ suggestedPrice: 11900 })
  })

  it('does not create an approval when the product VAT is not configured', async () => {
    const { service, approvals, costing } = repostFakes(null)
    const res = await service.repostProductPrices(PRODUCT, 'user-1')
    expect(res.data.reposted).toBe(0)
    expect(res.data.errors[0]).toMatch(/Configura el IVA del producto/)
    expect(approvals.create).not.toHaveBeenCalled()
    expect(costing.calculateRecipeCost).not.toHaveBeenCalled()
  })

  it('accepts VAT-excluded products (0 %) explicitly', async () => {
    const { service, approvals } = repostFakes(0)
    await service.repostProductPrices(PRODUCT, 'user-1')
    expect(approvals.create.mock.calls[0]?.[0]).toMatchObject({ suggestedPrice: 10000, taxRate: 0 })
  })
})

function approval(overrides: Partial<PriceApprovalDomain> = {}): PriceApprovalDomain {
  return {
    id: 'a1',
    variantSku: 'VELA-1',
    productSlug: 'vela',
    productName: 'Vela',
    previousCost: 4000,
    newCost: 5000,
    materialsCost: 5000,
    previousPrice: 9000,
    suggestedPrice: 11900,
    suggestedPriceNet: 10000,
    taxRate: 19,
    priceBasis: 'tax_included',
    marginPercentage: 100,
    currency: 'COP',
    status: 'approved',
    recipeVersion: 2,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  }
}

function publishFakes(items: PriceApprovalDomain[], variant: { price: number } | null = { price: 9000 }, taxRate: number | null = 19) {
  const byId = new Map(items.map((a) => [a.id, a]))
  const approvals = {
    getById: vi.fn(async (id: string) => byId.get(id) ?? null),
    update: vi.fn(async (id: string) => ({ ...byId.get(id), status: 'published' })),
  }
  const products = {
    getVariantRaw: vi.fn(async (..._a: unknown[]) => variant),
    findBySlugOrId: vi.fn(async (..._a: unknown[]) => ({ taxRate })),
    updateVariantPrice: vi.fn(async (..._a: unknown[]) => true),
  }
  const audit = { insert: vi.fn(async (..._a: unknown[]) => undefined) }
  const service = new PriceApprovalService(approvals as never, audit as never, products as never)
  return { service, approvals, products }
}

describe('publish prices', () => {
  it('writes the VAT-inclusive price', async () => {
    const { service, products } = publishFakes([approval()])
    await service.publish(['a1'], 'user-2')
    expect(products.updateVariantPrice).toHaveBeenCalledWith('VELA-1', 11900)
  })

  it('refuses approvals created with the old rule (price without VAT)', async () => {
    const { service, products } = publishFakes([approval({ priceBasis: 'legacy', suggestedPriceNet: undefined, taxRate: undefined, suggestedPrice: 10000 })])
    await expect(service.publish(['a1'], 'user-2')).rejects.toThrow(/regla anterior/)
    expect(products.updateVariantPrice).not.toHaveBeenCalled()
  })

  it('refuses when the variant price changed after the approval was created', async () => {
    const { service, products } = publishFakes([approval()], { price: 9500 })
    await expect(service.publish(['a1'], 'user-2')).rejects.toThrow(/precio cambió/)
    expect(products.updateVariantPrice).not.toHaveBeenCalled()
  })

  it('refuses when the product VAT changed after the approval was created', async () => {
    const { service, products } = publishFakes([approval()], { price: 9000 }, 5)
    await expect(service.publish(['a1'], 'user-2')).rejects.toThrow(/IVA del producto cambió/)
    expect(products.updateVariantPrice).not.toHaveBeenCalled()
  })

  it('publishes nothing when one approval of the batch is invalid', async () => {
    const { service, products, approvals } = publishFakes([approval(), approval({ id: 'a2', status: 'pending' })])
    await expect(service.publish(['a1', 'a2'], 'user-2')).rejects.toThrow(/estado "pending"/)
    expect(products.updateVariantPrice).not.toHaveBeenCalled()
    expect(approvals.update).not.toHaveBeenCalled()
  })

  it('approves nothing when one approval of the batch is not pending', async () => {
    const { service, approvals } = publishFakes([approval({ status: 'pending' }), approval({ id: 'a2', status: 'approved' })])
    await expect(service.approve(['a1', 'a2'], 'user-2')).rejects.toThrow(/estado "approved"/)
    expect(approvals.update).not.toHaveBeenCalled()
  })
})

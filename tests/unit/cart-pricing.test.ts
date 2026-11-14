import { describe, expect, it, vi } from 'vitest'
import { CartService } from '../../src/modules/sales/services/cart.service.js'

function service(variant: { sku: string; price: number; product_slug: string } | null) {
  const saved: unknown[][] = []
  const carts = {
    findByKey: vi.fn(async () => null),
    save: vi.fn(async (...args: unknown[]) => void saved.push(args)),
  }
  const products = { getVariantBySku: vi.fn(async () => variant) }
  return { svc: new CartService(carts as never, products as never), saved }
}

describe('CartService.addItem pricing', () => {
  it('uses the catalog price and slug, ignoring what the browser sends', async () => {
    const { svc, saved } = service({ sku: 'A-1', price: 45000, product_slug: 'vela' })
    await svc.addItem('k', { sku: 'A-1', quantity: 2, product: { productSlug: 'falso', productName: 'Vela', currency: 'COP' } })
    const items = saved[0]![1] as Array<{ unitPrice: number; productSlug: string }>
    expect(items[0]).toMatchObject({ unitPrice: 45000, productSlug: 'vela' })
  })

  it('rejects unknown SKUs instead of pricing them at 0', async () => {
    const { svc, saved } = service(null)
    await expect(svc.addItem('k', { sku: 'NOPE', quantity: 1 })).rejects.toMatchObject({ statusCode: 404 })
    expect(saved).toHaveLength(0)
  })

  it('rejects variants without a valid price', async () => {
    const { svc } = service({ sku: 'A-1', price: 0, product_slug: 'vela' })
    await expect(svc.addItem('k', { sku: 'A-1', quantity: 1 })).rejects.toMatchObject({ statusCode: 404 })
  })
})

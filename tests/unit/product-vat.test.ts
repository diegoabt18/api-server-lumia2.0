import { describe, it, expect, vi } from 'vitest'
import { AdminProductService } from '../../src/modules/admin/services/admin-product.service.js'
import { adminProductCreateSchema, adminProductPatchSchema } from '../../src/modules/admin/schemas/admin.schema.js'

function service(productOverrides: Record<string, unknown> = {}) {
  const domain = (taxRate: number | null) => ({
    id: 'p1', name: 'Vela', slug: 'vela', taxRate, status: 'active', variants: [], createdAt: new Date(), updatedAt: new Date(),
  })
  const products = {
    createProduct: vi.fn(async (..._a: unknown[]) => domain(19)),
    updateProduct: vi.fn(async (..._a: unknown[]) => domain(19)),
    ...productOverrides,
  }
  const categories = { findBySlug: vi.fn(async (..._a: unknown[]) => ({ slug: 'velas' })) }
  return { svc: new AdminProductService(products as never, categories as never, {} as never), products }
}

describe('product VAT: create', () => {
  it('persists a configured VAT rate on create', async () => {
    const { svc, products } = service()
    const res = await svc.create({ name: 'Vela', slug: 'vela', tax_rate: 19 })
    expect(products.createProduct.mock.calls[0][0]).toMatchObject({ tax_rate: 19 })
    expect(res.product.taxRate).toBe(19)
  })

  it('leaves VAT out when not provided, so the stored value defaults to null', async () => {
    const { svc, products } = service()
    await svc.create({ name: 'Vela', slug: 'vela' })
    expect(products.createProduct.mock.calls[0][0]).not.toHaveProperty('tax_rate')
  })

  it('rejects out-of-range rates at the schema', () => {
    expect(adminProductCreateSchema.safeParse({ name: 'V', slug: 'v', tax_rate: 150 }).success).toBe(false)
    expect(adminProductCreateSchema.safeParse({ name: 'V', slug: 'v', tax_rate: 5 }).success).toBe(true)
  })
})

describe('product VAT: update', () => {
  it('changes only the VAT field when that is the only patch', async () => {
    const { svc, products } = service()
    await svc.update('p1', { tax_rate: 5 })
    expect(products.updateProduct).toHaveBeenCalledWith('p1', { tax_rate: 5 })
  })

  it('does not touch VAT when the field is omitted from an unrelated edit', async () => {
    const { svc, products } = service()
    await svc.update('p1', { name: 'Vela nueva' })
    const patch = products.updateProduct.mock.calls[0][1] as Record<string, unknown>
    expect(patch).not.toHaveProperty('tax_rate')
    expect(Object.keys(patch)).toEqual(['name'])
  })

  it('never includes price fields when assigning VAT (catalog prices stay tax-inclusive and unchanged)', async () => {
    const { svc, products } = service()
    await svc.update('p1', { tax_rate: 19 })
    const patch = products.updateProduct.mock.calls[0][1] as Record<string, unknown>
    expect(Object.keys(patch).some((k) => /price/i.test(k))).toBe(false)
  })

  it('allows an explicit null to return a product to not configured', async () => {
    const { svc, products } = service()
    await svc.update('p1', { tax_rate: null })
    expect(products.updateProduct).toHaveBeenCalledWith('p1', { tax_rate: null })
  })

  it('rejects an invalid rate in the patch schema', () => {
    expect(adminProductPatchSchema.safeParse({ tax_rate: -5 }).success).toBe(false)
    expect(adminProductPatchSchema.safeParse({ tax_rate: 19.5 }).success).toBe(true)
  })

  it('reports not found without writing when the product does not exist', async () => {
    const { svc } = service({ updateProduct: vi.fn(async (..._a: unknown[]) => null) })
    await expect(svc.update('nope', { tax_rate: 19 })).rejects.toThrow(/no encontrado/)
  })
})

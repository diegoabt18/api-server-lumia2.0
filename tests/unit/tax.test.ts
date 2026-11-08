import { describe, it, expect } from 'vitest'
import { includedTaxAmount } from '../../src/modules/sales/domain/tax.js'
import { buildOrderFinancialPayload } from '../../src/modules/sales/services/order-financial-events.service.js'
import { adminProductPatchSchema } from '../../src/modules/admin/schemas/admin.schema.js'
import type { OrderEntity } from '../../src/modules/sales/domain/order.entity.js'

function order(items: Array<{ taxRate?: number | null; subtotal: number }>, extra: Partial<OrderEntity> = {}): OrderEntity {
  return {
    _id: 'o1',
    userId: 'u1',
    email: null,
    customerName: 'Ana',
    phone: '',
    address: '',
    city: '',
    reference: '',
    items: items.map((i, n) => ({
      productId: `p${n}`,
      variantSku: `SKU-${n}`,
      name: 'x',
      quantity: 1,
      unitPrice: i.subtotal,
      subtotal: i.subtotal,
      taxRate: i.taxRate,
    })),
    subtotal: items.reduce((s, i) => s + i.subtotal, 0),
    tax: 0,
    total: items.reduce((s, i) => s + i.subtotal, 0),
    status: 'paid',
    paymentStatus: 'paid',
    currency: 'COP',
    createdAt: new Date(),
    ...extra,
  } as unknown as OrderEntity
}

describe('included IVA', () => {
  it('extracts IVA from a price that already includes it', () => {
    expect(includedTaxAmount(119000, 19)).toBe(19000)
    expect(includedTaxAmount(10000, 0)).toBe(0)
  })

  it('returns null when no rate is configured instead of assuming one', () => {
    expect(includedTaxAmount(10000, null)).toBeNull()
    expect(includedTaxAmount(10000, undefined)).toBeNull()
  })
})

describe('financial payload tax', () => {
  it('sums per-line IVA when every line has a rate', () => {
    const payload = buildOrderFinancialPayload(order([{ taxRate: 19, subtotal: 119000 }, { taxRate: 5, subtotal: 105000 }]), null)
    expect(payload.tax).toBe(19000 + 5000)
    expect(payload.taxRateMissing).toBe(false)
    expect(payload.lines?.map((l) => l.taxAmount)).toEqual([19000, 5000])
  })

  it('flags an incomplete tax when any line lacks a rate', () => {
    const payload = buildOrderFinancialPayload(order([{ taxRate: 19, subtotal: 119000 }, { taxRate: null, subtotal: 50000 }], { tax: 0 }), null)
    expect(payload.taxRateMissing).toBe(true)
    expect(payload.lines?.[1].taxAmount).toBeNull()
  })
})

describe('admin product tax rate validation', () => {
  it('accepts a percentage between 0 and 100 or null', () => {
    expect(adminProductPatchSchema.safeParse({ tax_rate: 19 }).success).toBe(true)
    expect(adminProductPatchSchema.safeParse({ tax_rate: null }).success).toBe(true)
    expect(adminProductPatchSchema.safeParse({ tax_rate: 150 }).success).toBe(false)
    expect(adminProductPatchSchema.safeParse({ tax_rate: -1 }).success).toBe(false)
  })
})

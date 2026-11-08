import { describe, it, expect, vi } from 'vitest'
import { PosSaleService } from '../../src/modules/pos/services/pos-sale.service.js'
import { StoreSettingsRepository } from '../../src/modules/store/infrastructure/store-settings.repository.js'

function settingsWith(stored: unknown) {
  const updateOne = vi.fn(async () => ({}))
  const findOne = vi.fn(async () => stored)
  const db = {
    collection: () => ({ findOne, updateOne }),
  } as never
  return { repo: new StoreSettingsRepository(db), findOne, updateOne }
}

describe('POS payment methods source', () => {
  it('enables cash and bank transfer when the stored document predates them', async () => {
    const { repo } = settingsWith({
      _id: 'default',
      methods: [
        { methodId: 'mercadopago', isActive: false },
        { methodId: 'manual', isActive: true },
      ],
    })
    const settings = await repo.getPaymentSettings()
    const active = settings.methods.filter((m) => m.isActive).map((m) => m.methodId)
    expect(active).toContain('cash')
    expect(active).toContain('bank_transfer')
    expect(settings.methods.find((m) => m.methodId === 'mercadopago')?.isActive).toBe(false)
  })

  it('respects an explicit deactivation of cash', async () => {
    const { repo } = settingsWith({
      _id: 'default',
      methods: [{ methodId: 'cash', isActive: false }],
    })
    const settings = await repo.getPaymentSettings()
    expect(settings.methods.find((m) => m.methodId === 'cash')?.isActive).toBe(false)
    expect(settings.methods.filter((m) => m.methodId === 'cash')).toHaveLength(1)
  })

  it('persists the complete method list so an omitted entry cannot disable a method', async () => {
    const { repo, updateOne } = settingsWith(null)
    await repo.upsertPaymentSettings([{ methodId: 'manual', isActive: true }] as never, undefined)
    const update = (updateOne.mock.calls as unknown as Array<[unknown, { $set: { methods: Array<{ methodId: string }> } }]>)[0][1]
    const ids = update.$set.methods.map((m) => m.methodId).sort()
    expect(ids).toEqual(['bank_transfer', 'cash', 'manual', 'mercadopago'])
  })
})

describe('POS customer search', () => {
  it('searches all accounts (staff included) with the normalized term', async () => {
    const listAll = vi.fn(async () => ({ items: [], total: 0 }))
    const service = new PosSaleService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { listAll } as never,
      {} as never,
      {} as never,
      { findOrCreate: async (input: { name?: string }) => ({ id: 'pc-1', name: input.name || 'Consumidor final', email: null, phone: null }), findById: async () => null, search: async () => [] } as never,
      { enqueue: async () => true } as never,
    )
    await service.searchCustomers('  Diego  ', 10)
    expect(listAll).toHaveBeenCalledWith(0, 10, { type: 'all', search: 'Diego' })
  })
})

describe('payment method display text', () => {
  it('uses the stored text when present and the code fallback otherwise', async () => {
    const { resolvePaymentMethodDisplay } = await import('../../src/modules/payments/domain/payment-method.js')
    const stored = resolvePaymentMethodDisplay('cash', { displayName: 'Caja', description: 'Desde BD' })
    expect(stored.displayName).toBe('Caja')
    expect(stored.description).toBe('Desde BD')
    expect(stored.estimatedProcessingTime).toBe('Inmediato')

    const fallback = resolvePaymentMethodDisplay('bank_transfer')
    expect(fallback.displayName).toBe('Transferencia bancaria')
  })
})

describe('POS counter customers', () => {
  it('normalizes phone and email for deduplication', async () => {
    const { normalizePhone, normalizeEmail } = await import(
      '../../src/modules/identity/infrastructure/pos-customer.repository.js'
    )
    expect(normalizePhone('+57 300-123 4567')).toBe('573001234567')
    expect(normalizePhone('12')).toBeNull()
    expect(normalizeEmail('  Ana@Gmail.COM ')).toBe('ana@gmail.com')
    expect(normalizeEmail('   ')).toBeNull()
  })

  it('creates a counter customer for walk-in data and links it to the sale', async () => {
    const { PosSaleService } = await import('../../src/modules/pos/services/pos-sale.service.js')
    const findOrCreate = vi.fn(async () => ({ id: 'pc-9', name: 'Ana', email: null, phone: '3001234567' }))
    const orders = {
      findByIdempotencyKey: vi.fn(async () => null),
      generatePosOrderNumber: vi.fn(async () => 'POS-9'),
      createPosOrder: vi.fn(async (data: Record<string, unknown>) => ({ _id: 'o9', ...data })),
    }
    const products = {
      getVariantBySku: vi.fn(async () => ({ sku: 'X1', product_slug: 'p', price: 1000, currency: 'COP' })),
      findBySlugOrId: vi.fn(async () => ({
        id: 'id-p', slug: 'p', name: 'P', imagePath: null, categorySlug: null,
        variants: [{ sku: 'X1', price: 1000, currency: 'COP', inventory: [] }],
      })),
    }
    const payments = { savePayment: vi.fn(async () => undefined) }
    const storeSettings = {
      getPaymentSettings: vi.fn(async () => ({
        methods: [{ methodId: 'cash', isActive: true }],
        bankTransferDetails: null,
      })),
    }
    const service = new PosSaleService(
      orders as never,
      products as never,
      { decrementAtomic: async () => true, incrementAtomic: async () => true, getBySku: async () => null, logMovement: async () => undefined } as never,
      { findActiveAt: async () => [] } as never,
      {} as never,
      payments as never,
      storeSettings as never,
      { findOrCreate, findById: async () => null, search: async () => [] } as never,
      { enqueue: async () => true } as never,
    )
    await service.createSale(
      {
        customer: { mode: 'walk_in', name: 'Ana', phone: '3001234567' },
        items: [{ sku: 'X1', quantity: 1 }],
        payment: { method: 'cash', state: 'pending_manual' },
      } as never,
      { userId: 'admin-1' },
      'idem-key-counter-1',
    )
    expect(findOrCreate).toHaveBeenCalledTimes(1)
    const data = (orders.createPosOrder.mock.calls as unknown as Array<[{ posCustomerId: string | null }]>)[0][0]
    expect(data.posCustomerId).toBe('pc-9')
  })

  it('keeps fully anonymous walk-in sales without a counter customer', async () => {
    const { PosSaleService } = await import('../../src/modules/pos/services/pos-sale.service.js')
    const findOrCreate = vi.fn()
    const orders = {
      findByIdempotencyKey: vi.fn(async () => null),
      generatePosOrderNumber: vi.fn(async () => 'POS-10'),
      createPosOrder: vi.fn(async (data: Record<string, unknown>) => ({ _id: 'o10', ...data })),
    }
    const products = {
      getVariantBySku: vi.fn(async () => ({ sku: 'X1', product_slug: 'p', price: 1000, currency: 'COP' })),
      findBySlugOrId: vi.fn(async () => ({
        id: 'id-p', slug: 'p', name: 'P', imagePath: null, categorySlug: null,
        variants: [{ sku: 'X1', price: 1000, currency: 'COP', inventory: [] }],
      })),
    }
    const service = new PosSaleService(
      orders as never,
      products as never,
      { decrementAtomic: async () => true, incrementAtomic: async () => true, getBySku: async () => null, logMovement: async () => undefined } as never,
      { findActiveAt: async () => [] } as never,
      {} as never,
      { savePayment: async () => undefined } as never,
      { getPaymentSettings: async () => ({ methods: [{ methodId: 'cash', isActive: true }], bankTransferDetails: null }) } as never,
      { findOrCreate, findById: async () => null, search: async () => [] } as never,
      { enqueue: async () => true } as never,
    )
    await service.createSale(
      {
        customer: { mode: 'walk_in' },
        items: [{ sku: 'X1', quantity: 1 }],
        payment: { method: 'cash', state: 'pending_manual' },
      } as never,
      { userId: 'admin-1' },
      'idem-key-anon-1',
    )
    expect(findOrCreate).not.toHaveBeenCalled()
    const data = (orders.createPosOrder.mock.calls as unknown as Array<[{ posCustomerId: string | null }]>)[0][0]
    expect(data.posCustomerId).toBeNull()
  })
})

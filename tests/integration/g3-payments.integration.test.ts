/**
 * Pruebas de integración G3 contra MongoDB real: bloqueo por pedido, reintentos con clave de
 * idempotencia, auditoría de políticas y pedidos históricos. Usa una base temporal que se borra al final.
 *
 *   MONGO_TEST_URI=mongodb://lumia:lumia_secret@127.0.0.1:27017/?authSource=admin npm run test:integration
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { MongoClient, ObjectId, type Db } from 'mongodb'
import { OrderRepository } from '../../src/modules/sales/infrastructure/order.repository.js'
import { PaymentRepository } from '../../src/modules/payments/infrastructure/payment.repository.js'
import { InventoryRepository } from '../../src/modules/catalog/infrastructure/inventory.repository.js'
import { ProductionAuditRepository } from '../../src/modules/production/infrastructure/production-audit.repository.js'
import { OrderPaymentService } from '../../src/modules/sales/services/order-payment.service.js'
import { OrderStockService } from '../../src/modules/sales/services/order-stock.service.js'
import { AdminInventoryService } from '../../src/modules/admin/services/admin-inventory.service.js'
import { depositPolicySchema } from '../../src/modules/catalog/domain/deposit-policy.js'

const uri = process.env.MONGO_TEST_URI
const describeIfDb = uri ? describe : describe.skip

const ACTOR = new ObjectId().toHexString()

function mixedOrderDoc() {
  return {
    userId: null,
    email: null,
    customerName: 'Ana',
    phone: '3000000000',
    address: 'Calle 1',
    city: 'Bogotá',
    reference: '',
    items: [
      { productId: 'lampara', variantSku: 'LAMP-01', name: 'Lámpara', quantity: 1, unitPrice: 100000, subtotal: 100000, fulfillmentMode: 'stock', depositPolicy: null, initialPaymentRequired: 100000, balanceDue: 0 },
      { productId: 'mesa', variantSku: 'MESA-01', name: 'Mesa', quantity: 1, unitPrice: 1000000, subtotal: 1000000, fulfillmentMode: 'made_to_order', depositPolicy: { type: 'fixed', value: 350000 }, initialPaymentRequired: 350000, balanceDue: 650000 },
      { productId: 'estanteria', variantSku: 'EST-01', name: 'Estantería', quantity: 1, unitPrice: 500000, subtotal: 500000, fulfillmentMode: 'made_to_order', depositPolicy: { type: 'percent', value: 35 }, initialPaymentRequired: 175000, balanceDue: 325000 },
    ],
    subtotal: 1600000,
    shippingCost: 0,
    tax: 0,
    discountAmount: 0,
    total: 1600000,
    initialPaymentRequired: 625000,
    paidAmount: 0,
    balanceDue: 1600000,
    status: 'pending',
    paymentStatus: 'unpaid',
    fulfillmentStatus: 'unfulfilled',
    currency: 'COP',
    paymentMethod: 'manual',
  }
}

describeIfDb('G3 — integración MongoDB', () => {
  let client: MongoClient
  let db: Db
  let orders: OrderRepository
  let payments: PaymentRepository
  let inventory: InventoryRepository
  let audit: ProductionAuditRepository
  let payService: OrderPaymentService
  const dbName = `test_g3_${Date.now()}`

  beforeAll(async () => {
    client = new MongoClient(uri as string, { serverSelectionTimeoutMS: 8000 })
    await client.connect()
    db = client.db(dbName)
    orders = new OrderRepository(db)
    payments = new PaymentRepository(db)
    inventory = new InventoryRepository(db)
    audit = new ProductionAuditRepository(db)
    payService = new OrderPaymentService(orders, payments, new OrderStockService(inventory, orders))
    await payments.ensureIndexes()
    await inventory.ensureIndexes()
  })

  afterAll(async () => {
    if (db) await db.dropDatabase()
    await client?.close()
  })

  /** Versión vigente de la política (la que la interfaz recibe y devuelve en cada guardado). */
  const versionOf = async (sku: string) => (await inventory.getDepositPolicyState(sku)).version

  async function newOrder(extra: Record<string, unknown> = {}) {
    const created = await orders.createOrder({ ...mixedOrderDoc(), ...extra } as never)
    return created.id
  }

  it('dos cobros simultáneos sobre el mismo saldo: uno solo se registra (sin sobrepago)', async () => {
    const id = await newOrder()
    const results = await Promise.allSettled([
      payService.registerPayment(id, { method: 'cash', amount: 625000, receivedAmount: 625000 }, { userId: ACTOR }),
      payService.registerPayment(id, { method: 'cash', amount: 625000, receivedAmount: 625000 }, { userId: ACTOR }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(String(rejected.reason.message)).toMatch(/otro cobro en curso/)

    const approved = await payments.listPaymentsByOrderId(id)
    expect(approved.filter((p) => p.status === 'approved')).toHaveLength(1)
    const order = await orders.findEntityById(id)
    // Solo el anticipo está pagado: el pedido no se marca como pagado hasta cubrir el saldo.
    expect(order?.status).toBe('pending')
    expect(order?.paidAmount).toBe(625000)
    // El bloqueo se libera al terminar.
    expect((order as unknown as { ledgerLock?: unknown }).ledgerLock).toBeUndefined()
  })

  it('reintento con la misma clave de idempotencia no vuelve a cobrar', async () => {
    const id = await newOrder()
    const first = await payService.registerPayment(
      id,
      { method: 'cash', amount: 625000, receivedAmount: 625000, idempotencyKey: 'pos-abono-1' },
      { userId: ACTOR },
    )
    const retry = await payService.registerPayment(
      id,
      { method: 'cash', amount: 625000, receivedAmount: 625000, idempotencyKey: 'pos-abono-1' },
      { userId: ACTOR },
    )
    expect(retry.paidAmount).toBe(first.paidAmount)
    expect((await payments.listPaymentsByOrderId(id)).filter((p) => p.status === 'approved')).toHaveLength(1)
  })

  it('un bloqueo abandonado (proceso caído) caduca y no deja el pedido inutilizable', async () => {
    const id = await newOrder({ ledgerLock: { token: 'huerfano', at: new Date(Date.now() - 10 * 60_000) } })
    const summary = await payService.registerPayment(
      id,
      { method: 'cash', amount: 625000, receivedAmount: 625000 },
      { userId: ACTOR },
    )
    expect(summary.paidAmount).toBe(625000)
  })

  it('transferencia: la misma referencia no se registra dos veces', async () => {
    const id = await newOrder()
    await payService.registerPayment(id, { method: 'bank_transfer', amount: 625000, transferReference: 'BANCO-REF-1' }, { userId: ACTOR })
    await expect(
      payService.registerPayment(id, { method: 'bank_transfer', amount: 975000, transferReference: 'BANCO-REF-1' }, { userId: ACTOR }),
    ).rejects.toThrow(/ya fue registrada/)
  })

  it('cambiar la política de un SKU no altera el pedido ya creado (snapshot)', async () => {
    const inv = new AdminInventoryService(inventory, audit)
    await inv.upsertBySku('MESA-01', { quantity: 0, is_per_order: true, expected_version: await versionOf('MESA-01'), deposit_policy: { type: 'fixed', value: 350000 } }, ACTOR)
    const id = await newOrder()
    await inv.upsertBySku('MESA-01', { expected_version: await versionOf('MESA-01'), deposit_policy: { type: 'percent', value: 90 } }, ACTOR)

    const order = await orders.findEntityById(id)
    const mesa = order?.items.find((i) => i.variantSku === 'MESA-01')
    expect(mesa?.depositPolicy).toEqual({ type: 'fixed', value: 350000 })
    const summary = await payService.getSummary(id)
    expect(summary.initialPaymentRequired).toBe(625000)
  })

  it('auditoría real: el cambio de política queda en el registro con actor, anterior y nueva', async () => {
    const inv = new AdminInventoryService(inventory, audit)
    await inv.upsertBySku(
      'EST-01',
      { expected_version: await versionOf('EST-01'), deposit_policy: { type: 'custom_authorized', value: 200000, authorization: { reason: 'cliente corporativo' } } },
      ACTOR,
    )
    const entries = await db
      .collection('production_audit_log')
      .find({ entity_type: 'inventory_sku', entity_id: 'EST-01' })
      .toArray()
    expect(entries).toHaveLength(1)
    const entry = entries[0]!
    expect(entry.event_type).toBe('deposit_policy_changed')
    expect(String(entry.performed_by)).toBe(ACTOR)
    expect(entry.previous_value).toBeNull()
    expect(entry.new_value.authorization.authorizedBy).toBe(ACTOR)
    expect(entry.new_value.authorization.reason).toBe('cliente corporativo')
  })

  it('una política guardada sin autorización no deja la clave authorization (null) y pasa la validación del checkout', async () => {
    const inv = new AdminInventoryService(inventory, audit)
    await inv.upsertBySku('NULL-AUTH-01', { quantity: 1, expected_version: 0, deposit_policy: { type: 'fixed', value: 350000 } }, ACTOR)
    const doc = await db.collection('inventory_items').findOne({ sku: 'NULL-AUTH-01' })
    expect(doc && 'authorization' in (doc.deposit_policy as object)).toBe(false)
    expect(depositPolicySchema.safeParse(doc?.deposit_policy).success).toBe(true)
  })

  it('versión obsoleta sobre un SKU ya existente: no crea un segundo documento (regresión)', async () => {
    const inv = new AdminInventoryService(inventory, audit)
    await inv.upsertBySku('DUP-01', { quantity: 3, expected_version: 0, deposit_policy: { type: 'percent', value: 10 } }, ACTOR)
    // Quien editó con versión 0 llega después: debe fallar sin insertar nada.
    await expect(
      inv.upsertBySku('DUP-01', { expected_version: 0, deposit_policy: { type: 'percent', value: 90 } }, ACTOR),
    ).rejects.toThrow(/cambió mientras la editabas/)
    expect(await db.collection('inventory_items').countDocuments({ sku: 'DUP-01' })).toBe(1)
    expect((await inventory.getDepositPolicyState('DUP-01')).policy).toMatchObject({ type: 'percent', value: 10 })
  })

  it('la ficha de producto indica la variante por pedido (isMadeToOrder) aunque no tenga stock', async () => {
    const { ProductRepository } = await import('../../src/modules/catalog/infrastructure/product.repository.js')
    const now = new Date()
    await db.collection('products').insertOne({ slug: 'mesa-ficha', name: 'Mesa ficha', status: 'active', category_slug: 'x', created_at: now, updated_at: now } as never)
    await db.collection('variants').insertOne({ sku: 'FICHA-01', product_slug: 'mesa-ficha', price: 900000, currency: 'COP', options: {}, created_at: now } as never)
    await db.collection('inventory_items').insertOne({ sku: 'FICHA-01', quantity: 0, reserved: 0, warehouse: 'main', is_per_order: true, updated_at: now } as never)
    const repo = new ProductRepository(db)
    const product = await repo.findBySlugOrId('mesa-ficha')
    const variant = product?.variants.find((v) => v.sku === 'FICHA-01') as unknown as { isMadeToOrder?: boolean; available?: number }
    expect(variant.isMadeToOrder).toBe(true)
    expect(variant.available).toBe(0)
  })

  it('actualizar solo la política conserva el stock; eliminarla queda auditado', async () => {
    const inv = new AdminInventoryService(inventory, audit)
    await inv.upsertBySku('LAMP-99', { quantity: 7, is_per_order: false }, ACTOR)
    await inv.upsertBySku('LAMP-99', { expected_version: await versionOf('LAMP-99'), deposit_policy: { type: 'percent', value: 10 } }, ACTOR)
    const row = await db.collection('inventory_items').findOne({ sku: 'LAMP-99' })
    expect(row?.quantity).toBe(7)

    await inv.upsertBySku('LAMP-99', { expected_version: await versionOf('LAMP-99'), deposit_policy: null }, ACTOR)
    const removal = await db
      .collection('production_audit_log')
      .find({ entity_id: 'LAMP-99', event_type: 'deposit_policy_removed' })
      .toArray()
    expect(removal).toHaveLength(1)
    expect(removal[0]!.new_value).toBeNull()
  })

  it('referencia de transferencia repetida entre pedidos distintos: el índice único global la rechaza aunque la búsqueda no la vea', async () => {
    const orderA = await newOrder()
    const orderB = await newOrder()
    await payService.registerPayment(orderA, { method: 'bank_transfer', amount: 625000, transferReference: 'GLOBAL-REF-9' }, { userId: ACTOR })

    // Simula la carrera: la búsqueda previa no encuentra la referencia (otro proceso aún no la confirmó).
    const blind = Object.create(payments) as PaymentRepository
    blind.findApprovedByProviderReference = async () => null
    const racing = new OrderPaymentService(orders, blind, new OrderStockService(inventory, orders))

    await expect(
      racing.registerPayment(orderB, { method: 'bank_transfer', amount: 625000, transferReference: 'GLOBAL-REF-9' }, { userId: ACTOR }),
    ).rejects.toThrow(/ya fue registrada/)
    const copies = await db.collection('payments').countDocuments({ providerPaymentId: 'GLOBAL-REF-9', status: 'approved' })
    expect(copies).toBe(1)
  })

  it('política con versión obsoleta: el segundo guardado es rechazado en la base real', async () => {
    const inv = new AdminInventoryService(inventory, audit)
    await inv.upsertBySku('CAS-01', { quantity: 1, expected_version: 0, deposit_policy: { type: 'percent', value: 20 } }, ACTOR)
    const v = (await inventory.getDepositPolicyState('CAS-01')).version
    // Dos editores partieron de la misma versión: el primero gana, el segundo recibe conflicto.
    await inv.upsertBySku('CAS-01', { expected_version: v, deposit_policy: { type: 'percent', value: 30 } }, ACTOR)
    await expect(
      inv.upsertBySku('CAS-01', { expected_version: v, deposit_policy: { type: 'percent', value: 40 } }, ACTOR),
    ).rejects.toThrow(/cambió mientras la editabas/)
    expect((await inventory.getDepositPolicyState('CAS-01')).policy).toMatchObject({ type: 'percent', value: 30 })
  })

  it('liquidar el saldo con una expectativa de pago pendiente: el pedido queda pagado y el stock se descuenta', async () => {
    const id = await newOrder({ stockDecrementedAt: null })
    // Expectativa creada al hacer el checkout (pago pendiente de tipo manual).
    await payments.savePayment({
      orderId: id,
      attemptNumber: 1,
      status: 'pending',
      paymentMethod: 'manual',
      externalReference: `order-${id}-manual-1`,
      amount: 625000,
      currency: 'COP',
      refundedAmount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      events: [],
    } as never)
    const stock = { applyOnPaid: vi.fn(async () => true) }
    const svc = new OrderPaymentService(orders, payments, stock as never)
    await svc.registerPayment(id, { method: 'cash', amount: 625000, receivedAmount: 625000 }, { userId: ACTOR })
    const summary = await svc.registerPayment(id, { method: 'cash', amount: 975000, receivedAmount: 975000 }, { userId: ACTOR })
    expect(summary.paymentStatus).toBe('paid')
    expect(stock.applyOnPaid).toHaveBeenCalledTimes(1)
    const pending = (await payments.listPaymentsByOrderId(id)).find((p) => p.attemptNumber === 1)
    expect(pending?.status).toBe('cancelled')
  })

  it('pedido histórico sin libro de pagos ya pagado no admite nuevos cobros', async () => {
    // Documento anterior a G3: no tiene ninguno de los campos del libro de pagos.
    const legacy = mixedOrderDoc() as Record<string, unknown>
    for (const key of ['initialPaymentRequired', 'paidAmount', 'balanceDue']) delete legacy[key]
    for (const item of legacy.items as Array<Record<string, unknown>>) {
      for (const key of ['fulfillmentMode', 'depositPolicy', 'initialPaymentRequired', 'balanceDue']) delete item[key]
    }
    const created = await orders.createOrder({ ...legacy, status: 'paid', paymentStatus: 'paid' } as never)
    const id = created.id
    await expect(
      payService.registerPayment(id, { method: 'cash', amount: 1, receivedAmount: 1 }, { userId: ACTOR }),
    ).rejects.toThrow(/anterior al libro de pagos/)
  })
})

describe('G3 — referencia corta del cliente (integración MongoDB)', () => {
  let client: MongoClient
  let db: Db
  beforeAll(async () => {
    client = new MongoClient(uri as string, { serverSelectionTimeoutMS: 8000 })
    await client.connect()
    db = client.db(`test_ref_${Date.now()}`)
  })
  afterAll(async () => {
    if (db) await db.dropDatabase()
    await client?.close()
  })

  it('índice único en la referencia y pedidos anteriores sin referencia localizables por su número', async () => {
    const orders = new OrderRepository(db)
    await orders.ensureIndexes()
    const indexes = await db.collection('orders').indexes()
    expect(indexes.find((i) => i.key?.customerReference === 1)?.unique).toBe(true)

    // Pedido anterior: sin referencia corta, se busca por su número interno.
    const legacy = await db.collection('orders').insertOne({ orderNumber: 'ORD-2026-000777', customerName: 'Antiguo', items: [], total: 1, status: 'pending', createdAt: new Date() } as never)
    expect(legacy.insertedId).toBeDefined()
    expect((await orders.findByOrderNumber('ord-2026-000777'))?.customerName).toBe('Antiguo')
  })

  it('creación simultánea: referencias distintas y cada pedido encontrable por su código', async () => {
    const orders = new OrderRepository(db)
    const created = await Promise.all(Array.from({ length: 20 }, () => orders.createOrder(mixedOrderDoc() as never)))
    const refs = created.map((o) => o.customerReference as string)
    expect(new Set(refs).size).toBe(refs.length)
    for (const o of created.slice(0, 3)) {
      expect(o.customerReference).toMatch(/^ORD-[0-9A-F]{8}$/)
      expect((await orders.findByOrderNumber(o.customerReference as string))?.id).toBe(o.id)
      expect((await orders.findByOrderNumber(o.orderNumber as string))?.id).toBe(o.id)
    }
  })

  it('búsqueda administrativa por referencia, sufijo, fragmento, nombre y correo (ejecutada en la base)', async () => {
    const orders = new OrderRepository(db)
    const doc = await orders.createOrder({ ...mixedOrderDoc(), customerName: 'Búsqueda Zeta', email: 'zeta@example.com' } as never)
    const ref = doc.customerReference as string
    const suffix = ref.slice(4)
    const byRef = await orders.listAllAdmin(0, 50, ref)
    const bySuffix = await orders.listAllAdmin(0, 50, suffix)
    const byFragment = await orders.listAllAdmin(0, 50, ref.slice(0, 7))
    const byName = await orders.listAllAdmin(0, 50, 'búsqueda zeta')
    const byEmail = await orders.listAllAdmin(0, 50, 'zeta@example')
    for (const found of [byRef, bySuffix, byFragment, byName, byEmail]) {
      expect(found.some((o) => o._id === doc.id)).toBe(true)
    }
  })
})

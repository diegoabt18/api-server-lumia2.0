/**
 * Auditoría 2026-11-14: bloqueo de checkout por carrito y escrituras condicionales de pedidos
 * contra MongoDB real. Usa una base temporal que se borra al final.
 *
 *   MONGO_TEST_URI=mongodb://127.0.0.1:27018 npm run test:integration
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoClient, ObjectId, type Db } from 'mongodb'
import { CartRepository, CHECKOUT_LOCK_TTL_MS } from '../../src/modules/sales/infrastructure/cart.repository.js'
import { OrderRepository } from '../../src/modules/sales/infrastructure/order.repository.js'

const uri = process.env.MONGO_TEST_URI
const describeIfDb = uri ? describe : describe.skip

describeIfDb('audit concurrency (MongoDB real)', () => {
  let client: MongoClient
  let db: Db
  const dbName = `lumia_audit_${Date.now()}`

  beforeAll(async () => {
    client = new MongoClient(uri!)
    await client.connect()
    db = client.db(dbName)
  })

  afterAll(async () => {
    await db?.dropDatabase()
    await client?.close()
  })

  it('only one concurrent checkout can claim the same cart', async () => {
    const carts = new CartRepository(db)
    await carts.save('cart-1', [
      { sku: 'A', productSlug: 'a', productName: 'A', quantity: 1, unitPrice: 1000 } as never,
    ])
    const results = await Promise.all(Array.from({ length: 8 }, () => carts.claimCheckout('cart-1')))
    expect(results.filter(Boolean)).toHaveLength(1)

    await carts.releaseCheckout('cart-1')
    expect(await carts.claimCheckout('cart-1')).toBe(true)
  })

  it('a stale checkout lock can be reclaimed', async () => {
    const carts = new CartRepository(db)
    await carts.save('cart-2', [])
    const past = new Date(Date.now() - CHECKOUT_LOCK_TTL_MS - 1000)
    expect(await carts.claimCheckout('cart-2', past)).toBe(true)
    expect(await carts.claimCheckout('cart-2')).toBe(true)
  })

  it('admin status writes are conditional on the status that was read', async () => {
    const orders = new OrderRepository(db)
    const id = new ObjectId()
    await db.collection('orders').insertOne({
      _id: id,
      status: 'paid',
      paymentStatus: 'paid',
      items: [],
      total: 0,
      events: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    const attempts = await Promise.allSettled([
      orders.adminPatch(id.toHexString(), { status: 'shipped' }, 'admin-1'),
      orders.adminPatch(id.toHexString(), { status: 'cancelled' }, 'admin-2'),
    ])
    const fulfilled = attempts.filter((a) => a.status === 'fulfilled')
    const rejected = attempts.filter((a) => a.status === 'rejected')
    // Ambos leen "paid"; solo una escritura puede aplicarse sobre ese estado.
    expect(fulfilled.length).toBe(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ statusCode: 409 })
  })

  it('cancellation can only be resolved while a request is open', async () => {
    const orders = new OrderRepository(db)
    const id = new ObjectId()
    await db.collection('orders').insertOne({
      _id: id,
      status: 'pending',
      paymentStatus: 'unpaid',
      items: [],
      total: 0,
      events: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    await expect(
      orders.resolveCancellationRequest(id.toHexString(), 'approved', 'admin-1'),
    ).rejects.toMatchObject({ statusCode: 409 })

    await db.collection('orders').updateOne({ _id: id }, { $set: { cancellationRequestStatus: 'requested' } })
    const resolved = await orders.resolveCancellationRequest(id.toHexString(), 'approved', 'admin-1')
    expect(resolved?.status).toBe('cancelled')
  })
})

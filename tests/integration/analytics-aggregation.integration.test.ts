/**
 * P5: la analítica se calcula con agregaciones de MongoDB. Esta prueba compara el resultado con el
 * algoritmo anterior (todos los pedidos en memoria) sobre los mismos datos aleatorios.
 *
 *   MONGO_TEST_URI=mongodb://127.0.0.1:27018 npm run test:integration
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoClient, ObjectId, type Db } from 'mongodb'
import { OrderRepository } from '../../src/modules/sales/infrastructure/order.repository.js'
import { AdminAnalyticsService } from '../../src/modules/admin/services/admin-analytics.service.js'

const uri = process.env.MONGO_TEST_URI
const describeIfDb = uri ? describe : describe.skip

const STATUSES = ['pending', 'paid', 'shipped', 'delivered', 'cancelled', 'expired']
const METHODS = ['manual', 'cash', 'bank_transfer', '', null, undefined]
const SOLD = ['paid', 'shipped', 'delivered']

type Doc = Record<string, unknown> & {
  status: string
  total: number | null
  createdAt: Date
  paymentMethod?: string | null
  paymentStatus: string
  items: Array<{ productSlug?: string; productId?: string; subtotal?: number | null; quantity?: number }>
}

let seed = 42
function rand(): number {
  seed = (seed * 1103515245 + 12345) % 2 ** 31
  return seed / 2 ** 31
}
const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!

function makeOrders(now: Date, n: number): Doc[] {
  const docs: Doc[] = []
  for (let i = 0; i < n; i++) {
    const ageMs = Math.floor(rand() * 75 * 86400000)
    const items = Array.from({ length: 1 + Math.floor(rand() * 3) }, (_, k) => ({
      productSlug: pick(['vela-a', 'vela-b', 'mesa', '', undefined]) as string | undefined,
      productId: `pid-${k}`,
      subtotal: pick([1000, 2500, 40000, null]) as number | null,
      quantity: 1 + Math.floor(rand() * 4),
    }))
    docs.push({
      _id: new ObjectId(),
      status: pick(STATUSES),
      total: pick([10000, 25000, 123456, null]) as number | null,
      createdAt: new Date(now.getTime() - ageMs),
      paymentMethod: pick(METHODS) as string | null,
      paymentStatus: pick(['unpaid', 'paid', 'refunded']),
      items,
    })
  }
  return docs
}

/** Algoritmo anterior (copiado de la versión en memoria) para comparar. */
function legacyOverview(docs: Doc[], now: Date, days: number) {
  const currentFrom = new Date(now.getTime() - days * 86400000)
  const previousFrom = new Date(currentFrom.getTime() - days * 86400000)
  const inRange = (from: Date, to: Date) => docs.filter((d) => d.createdAt >= from && d.createdAt < to)
  const metrics = (list: Doc[]) => {
    const revenue = list.filter((o) => SOLD.includes(o.status)).reduce((s, o) => s + (o.total || 0), 0)
    return { revenue, orders: list.length, aov: list.length ? Math.round(revenue / list.length) : 0 }
  }
  const current = inRange(currentFrom, now)
  const prodMap = new Map<string, { slug: string; revenue: number; units: number }>()
  for (const o of current) {
    if (!SOLD.includes(o.status)) continue
    for (const item of o.items) {
      const slug = item.productSlug || item.productId
      if (!slug) continue
      const e = prodMap.get(slug) || { slug, revenue: 0, units: 0 }
      e.revenue += item.subtotal || 0
      e.units += item.quantity || 0
      prodMap.set(slug, e)
    }
  }
  const dayMap = new Map<string, { revenue: number; orders: number }>()
  for (let i = days - 1; i >= 0; i--) dayMap.set(new Date(now.getTime() - i * 86400000).toISOString().slice(0, 10), { revenue: 0, orders: 0 })
  for (const o of current) {
    if (!SOLD.includes(o.status)) continue
    const e = dayMap.get(o.createdAt.toISOString().slice(0, 10))
    if (!e) continue
    e.revenue += o.total || 0
    e.orders += 1
  }
  return {
    current: metrics(current),
    previous: metrics(inRange(previousFrom, currentFrom)),
    products: [...prodMap.values()].sort((a, b) => b.revenue - a.revenue || a.slug.localeCompare(b.slug)).slice(0, 10),
    days: [...dayMap.entries()].map(([date, d]) => ({ date, revenue: Math.round(d.revenue), orders: d.orders })),
  }
}

function legacySales(docs: Doc[], from: Date, to: Date) {
  const list = docs.filter((d) => d.createdAt >= from && d.createdAt < to)
  const byStatus = new Map<string, number>()
  const byPayment = new Map<string, number>()
  let revenue = 0
  let refunds = 0
  for (const o of list) {
    byStatus.set(o.status, (byStatus.get(o.status) ?? 0) + 1)
    const pm = o.paymentMethod || 'unknown'
    byPayment.set(pm, (byPayment.get(pm) ?? 0) + 1)
    if (SOLD.includes(o.status)) revenue += o.total || 0
    if (o.paymentStatus === 'refunded') refunds += o.total || 0
  }
  const sort = (m: Map<string, number>) => [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  return { total: list.length, revenue, refunds, byStatus: sort(byStatus), byPayment: sort(byPayment) }
}

describeIfDb('analytics aggregation equals the previous in-memory computation', () => {
  let client: MongoClient
  let db: Db
  const dbName = `lumia_analytics_${Date.now()}`
  const now = new Date()
  let docs: Doc[]
  let service: AdminAnalyticsService

  beforeAll(async () => {
    client = new MongoClient(uri!)
    await client.connect()
    db = client.db(dbName)
    docs = makeOrders(now, 600)
    await db.collection('orders').insertMany(docs)
    service = new AdminAnalyticsService(
      new OrderRepository(db),
      { countCreatedBetween: async () => 0 } as never,
      { findNamesBySlugs: async () => new Map<string, string>() } as never,
    )
  })

  afterAll(async () => {
    await db?.dropDatabase()
    await client?.close()
  })

  it.each([
    ['7d', 7],
    ['30d', 30],
  ] as const)('overview %s', async (period, days) => {
    // El servicio usa su propio "ahora": se fija el reloj del cálculo de referencia al mismo instante aproximado.
    const result = await service.getOverview({ period })
    const legacy = legacyOverview(docs, new Date(result.period.to), days)
    expect(result.revenue.current).toBe(Math.round(legacy.current.revenue))
    expect(result.revenue.previous).toBe(Math.round(legacy.previous.revenue))
    expect(result.orders.current).toBe(legacy.current.orders)
    expect(result.orders.previous).toBe(legacy.previous.orders)
    expect(result.aov.current).toBe(legacy.current.aov)
    expect(result.revenueByDay).toEqual(legacy.days)
    expect(result.topProducts.map((p) => ({ slug: p.slug, revenue: p.revenue, units: p.units }))).toEqual(legacy.products)
  })

  it('sales 90d', async () => {
    const result = await service.getSales({ period: '90d' })
    const legacy = legacySales(docs, new Date(result.period.from), new Date(result.period.to))
    expect(result.orders.total).toBe(legacy.total)
    expect(result.revenue.total).toBe(Math.round(legacy.revenue))
    expect(result.refunds.total).toBe(Math.round(legacy.refunds))
    const sorted = (xs: Array<{ count: number }>, key: 'status' | 'method') =>
      xs.map((x) => [(x as Record<string, unknown>)[key] as string, x.count]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    expect(sorted(result.orders.byStatus, 'status')).toEqual(legacy.byStatus)
    expect(sorted(result.revenue.byPaymentMethod, 'method')).toEqual(legacy.byPayment)
  })

  it('uses the createdAt index (no collection scan)', async () => {
    await new OrderRepository(db).ensureIndexes()
    const explain = await db
      .collection('orders')
      .find({ createdAt: { $gte: new Date(now.getTime() - 7 * 86400000), $lt: now } })
      .explain('queryPlanner')
    expect(JSON.stringify(explain.queryPlanner.winningPlan)).toContain('IXSCAN')
  })
})

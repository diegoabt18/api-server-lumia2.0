import type { OrderRepository } from '../../sales/infrastructure/order.repository.js'
import type { UserRepository } from '../../identity/infrastructure/user.repository.js'
import type { ProductRepository } from '../../catalog/infrastructure/product.repository.js'

type Period = '7d' | '30d' | '90d' | '1y'

function parsePeriod(raw: unknown): Period {
  if (raw === '7d' || raw === '30d' || raw === '90d' || raw === '1y') return raw
  return '30d'
}

function growth(current: number, prev: number): number | null {
  if (prev === 0) return current > 0 ? 100 : null
  return Math.round(((current - prev) / prev) * 100)
}

export class AdminAnalyticsService {
  constructor(
    private readonly orders: OrderRepository,
    private readonly users: UserRepository,
    private readonly products: ProductRepository,
  ) {}

  private async orderMetrics(from: Date, to: Date) {
    const orderDocs = await this.orders.findManyInRange(from, to)
    const paid = orderDocs.filter((o) => ['paid', 'shipped', 'delivered'].includes(o.status))
    const revenue = paid.reduce((sum, o) => sum + (o.total || 0), 0)
    const orders = orderDocs.length
    return { revenue, orders, aov: orders > 0 ? Math.round(revenue / orders) : 0, orderDocs }
  }

  async getOverview(query: Record<string, unknown>) {
    const period = parsePeriod(query.period)
    const daysMap: Record<Period, number> = { '7d': 7, '30d': 30, '90d': 90, '1y': 365 }
    const days = daysMap[period]
    const now = new Date()
    const currentFrom = new Date(now.getTime() - days * 86400000)
    const previousFrom = new Date(currentFrom.getTime() - days * 86400000)

    const [current, previous, newCustomersCurrent, newCustomersPrevious] = await Promise.all([
      this.orderMetrics(currentFrom, now),
      this.orderMetrics(previousFrom, currentFrom),
      this.users.countCreatedBetween(currentFrom, now),
      this.users.countCreatedBetween(previousFrom, currentFrom),
    ])

    const productRevenueMap = new Map<string, { slug: string; revenue: number; units: number }>()
    for (const order of current.orderDocs) {
      if (!['paid', 'shipped', 'delivered'].includes(order.status)) continue
      for (const item of order.items || []) {
        const slug = item.productSlug || item.productId
        if (!slug) continue
        const existing = productRevenueMap.get(slug) || { slug, revenue: 0, units: 0 }
        existing.revenue += item.subtotal || 0
        existing.units += item.quantity || 0
        productRevenueMap.set(slug, existing)
      }
    }

    const slugs = [...productRevenueMap.keys()]
    const nameMap = slugs.length ? await this.products.findNamesBySlugs(slugs) : new Map<string, string>()
    const topProducts = [...productRevenueMap.values()]
      .map((d) => ({ slug: d.slug, name: nameMap.get(d.slug) || d.slug, revenue: d.revenue, units: d.units }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10)

    const dayMap = new Map<string, { revenue: number; orders: number }>()
    for (let i = days - 1; i >= 0; i--) {
      const key = new Date(now.getTime() - i * 86400000).toISOString().slice(0, 10)
      dayMap.set(key, { revenue: 0, orders: 0 })
    }
    for (const order of current.orderDocs) {
      if (!['paid', 'shipped', 'delivered'].includes(order.status)) continue
      const key = order.createdAt instanceof Date ? order.createdAt.toISOString().slice(0, 10) : null
      if (!key || !dayMap.has(key)) continue
      const entry = dayMap.get(key)!
      entry.revenue += order.total || 0
      entry.orders += 1
    }

    return {
      period: { from: currentFrom.toISOString(), to: now.toISOString(), label: period },
      previous: { from: previousFrom.toISOString(), to: currentFrom.toISOString(), label: 'Período anterior' },
      revenue: { current: Math.round(current.revenue), previous: Math.round(previous.revenue), growth: growth(current.revenue, previous.revenue) },
      orders: { current: current.orders, previous: previous.orders, growth: growth(current.orders, previous.orders) },
      aov: { current: current.aov, previous: previous.aov, growth: growth(current.aov, previous.aov) },
      newCustomers: {
        current: newCustomersCurrent,
        previous: newCustomersPrevious,
        growth: growth(newCustomersCurrent, newCustomersPrevious),
      },
      topProducts,
      revenueByDay: [...dayMap.entries()].map(([date, data]) => ({
        date,
        revenue: Math.round(data.revenue),
        orders: data.orders,
      })),
    }
  }

  async getSales(query: Record<string, unknown>) {
    const period = parsePeriod(query.period)
    const days = { '7d': 7, '30d': 30, '90d': 90, '1y': 365 }[period]
    const now = new Date()
    const from = new Date(now.getTime() - days * 86400000)
    const orderDocs = await this.orders.findManyInRange(from, now)

    const byStatus = new Map<string, number>()
    const byPayment = new Map<string, number>()
    let totalRevenue = 0
    let refundTotal = 0

    for (const o of orderDocs) {
      byStatus.set(o.status, (byStatus.get(o.status) ?? 0) + 1)
      const pm = o.paymentMethod || 'unknown'
      byPayment.set(pm, (byPayment.get(pm) ?? 0) + 1)
      if (['paid', 'shipped', 'delivered'].includes(o.status)) totalRevenue += o.total || 0
      if (o.paymentStatus === 'refunded') refundTotal += o.total || 0
    }

    const totalOrders = orderDocs.length
    return {
      period: { from: from.toISOString(), to: now.toISOString(), label: period },
      revenue: {
        total: Math.round(totalRevenue),
        byPaymentMethod: [...byPayment.entries()].map(([method, count]) => ({ method, count })),
      },
      orders: {
        total: totalOrders,
        byStatus: [...byStatus.entries()].map(([status, count]) => ({ status, count })),
        averageFulfillmentTime: null,
      },
      aov: { overall: totalOrders > 0 ? Math.round(totalRevenue / totalOrders) : 0, byMonth: [] },
      refunds: { total: Math.round(refundTotal), rate: totalRevenue > 0 ? Math.round((refundTotal / totalRevenue) * 100) : 0 },
    }
  }
}

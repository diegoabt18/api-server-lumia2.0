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

  private async orderMetrics(from: Date, to: Date, opts: { products?: boolean; days?: boolean } = {}) {
    const summary = await this.orders.analyticsSummary(from, to, opts)
    const orders = summary.orders
    return {
      revenue: summary.revenue,
      orders,
      aov: orders > 0 ? Math.round(summary.revenue / orders) : 0,
      summary,
    }
  }

  async getOverview(query: Record<string, unknown>) {
    const period = parsePeriod(query.period)
    const daysMap: Record<Period, number> = { '7d': 7, '30d': 30, '90d': 90, '1y': 365 }
    const days = daysMap[period]
    const now = new Date()
    const currentFrom = new Date(now.getTime() - days * 86400000)
    const previousFrom = new Date(currentFrom.getTime() - days * 86400000)

    const [current, previous, newCustomersCurrent, newCustomersPrevious] = await Promise.all([
      this.orderMetrics(currentFrom, now, { products: true, days: true }),
      this.orderMetrics(previousFrom, currentFrom),
      this.users.countCreatedBetween(currentFrom, now),
      this.users.countCreatedBetween(previousFrom, currentFrom),
    ])

    const productRevenueMap = new Map(current.summary.products.map((p) => [p.slug, p]))
    const slugs = [...productRevenueMap.keys()]
    const nameMap = slugs.length
      ? await this.products.findNamesBySlugs(slugs)
      : new Map<string, string>()
    const topProducts = [...productRevenueMap.values()]
      .map((d) => ({
        slug: d.slug,
        name: nameMap.get(d.slug) || d.slug,
        revenue: d.revenue,
        units: d.units,
      }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10)

    const dayMap = new Map<string, { revenue: number; orders: number }>()
    for (let i = days - 1; i >= 0; i--) {
      const key = new Date(now.getTime() - i * 86400000).toISOString().slice(0, 10)
      dayMap.set(key, { revenue: 0, orders: 0 })
    }
    // Solo los días del periodo (agrupados en UTC, igual que antes).
    for (const row of current.summary.days) {
      const entry = dayMap.get(row.date)
      if (!entry) continue
      entry.revenue += row.revenue
      entry.orders += row.orders
    }

    return {
      period: { from: currentFrom.toISOString(), to: now.toISOString(), label: period },
      previous: {
        from: previousFrom.toISOString(),
        to: currentFrom.toISOString(),
        label: 'Período anterior',
      },
      revenue: {
        current: Math.round(current.revenue),
        previous: Math.round(previous.revenue),
        growth: growth(current.revenue, previous.revenue),
      },
      orders: {
        current: current.orders,
        previous: previous.orders,
        growth: growth(current.orders, previous.orders),
      },
      aov: {
        current: current.aov,
        previous: previous.aov,
        growth: growth(current.aov, previous.aov),
      },
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
    const summary = await this.orders.analyticsSummary(from, now)
    const totalRevenue = summary.revenue
    const refundTotal = summary.refunds

    const totalOrders = summary.orders
    return {
      period: { from: from.toISOString(), to: now.toISOString(), label: period },
      revenue: {
        total: Math.round(totalRevenue),
        byPaymentMethod: summary.byPayment,
      },
      orders: {
        total: totalOrders,
        byStatus: summary.byStatus,
        averageFulfillmentTime: null,
      },
      aov: { overall: totalOrders > 0 ? Math.round(totalRevenue / totalOrders) : 0, byMonth: [] },
      refunds: {
        total: Math.round(refundTotal),
        rate: totalRevenue > 0 ? Math.round((refundTotal / totalRevenue) * 100) : 0,
      },
    }
  }
}

import type { CategoryRepository } from '../../catalog/infrastructure/category.repository.js'
import type { ProductRepository } from '../../catalog/infrastructure/product.repository.js'
import type { NotificationRepository } from '../../notifications/infrastructure/notification.repository.js'
import type { OrderEntity } from '../../sales/domain/order.entity.js'
import { ANALYTICS_SOLD_STATUSES, type OrderRepository } from '../../sales/infrastructure/order.repository.js'
import type { LumiInitiativeService } from '../initiatives/services/initiative.service.js'
import type { AssistantOrderRow, LumiToolDeps } from './tool.types.js'

/** Fila de pedido para el asistente: sin nombre, correo, teléfono ni dirección del cliente. */
export function toAssistantOrderRow(order: OrderEntity): AssistantOrderRow {
  const created = order.createdAt as unknown
  return {
    id: order._id ? String(order._id) : null,
    orderNumber: order.orderNumber ?? null,
    reference: order.customerReference ?? order.orderNumber ?? null,
    createdAt: created instanceof Date ? created.toISOString() : typeof created === 'string' ? created : null,
    status: order.status ?? null,
    paymentStatus: order.paymentStatus ?? null,
    fulfillmentStatus: order.fulfillmentStatus ?? null,
    total: typeof order.total === 'number' ? order.total : null,
    itemCount: Array.isArray(order.items) ? order.items.reduce((n, item) => n + (Number(item.quantity) || 0), 0) : 0,
  }
}

/** Puertos de lectura del catálogo de herramientas, sobre los repositorios del Server. */
export function createLumiToolDeps(repos: {
  orders: OrderRepository
  products: ProductRepository
  categories: CategoryRepository
  notifications: NotificationRepository
  initiatives: LumiInitiativeService
}): LumiToolDeps {
  return {
    orders: {
      async recent(limit) {
        return (await repos.orders.listAllAdmin(0, limit)).map(toAssistantOrderRow)
      },
      async findByReference(term, limit) {
        return (await repos.orders.findByReference(term, limit)).map(toAssistantOrderRow)
      },
      countByStatus(range) {
        return repos.orders.countByStatus(range)
      },
      async salesSummary(from, to) {
        const summary = await repos.orders.analyticsSummary(from, to, { products: true })
        const soldOrders = summary.byStatus
          .filter((s) => ANALYTICS_SOLD_STATUSES.includes(s.status))
          .reduce((n, s) => n + s.count, 0)
        const slugs = summary.products.map((p) => p.slug)
        const names = slugs.length ? await repos.products.findNamesBySlugs(slugs) : new Map<string, string>()
        return {
          orders: summary.orders,
          soldOrders,
          revenue: summary.revenue,
          refunds: summary.refunds,
          topProducts: summary.products.map((p) => ({ name: names.get(p.slug) ?? p.slug, units: p.units, revenue: p.revenue })),
        }
      },
    },
    products: {
      lowStock(threshold, limit) {
        return repos.products.findStockAlerts(threshold, limit)
      },
      unpriced(limit) {
        return repos.products.findUnpriced(limit)
      },
      untaxed(limit) {
        return repos.products.findUntaxed(limit)
      },
      taxed(limit) {
        return repos.products.findTaxed(limit)
      },
      async search(term, limit) {
        // Búsqueda común del Server (modo contains, sin tildes, palabra por palabra).
        return (await repos.products.searchProducts({ query: term, pageSize: limit })).items
      },
    },
    categories: {
      async list(limit) {
        // Una tienda tiene pocas categorías: se leen todas para ordenar por nombre sin tildes.
        const [all, counts] = await Promise.all([repos.categories.findAll(), repos.categories.productCountByCategorySlug()])
        const sorted = [...all].sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }))
        return {
          items: sorted.slice(0, limit).map((c) => ({ id: c.id, name: c.name, status: c.status, productCount: counts.get(c.slug) ?? 0 })),
          total: all.length,
        }
      },
    },
    initiatives: {
      list(userId, keys, limit) {
        return repos.initiatives.list(userId, keys, { limit })
      },
    },
    notifications: {
      countUnread(userId) {
        return repos.notifications.countUnread(userId)
      },
      recentUnread(userId, limit) {
        return repos.notifications.recentUnread(userId, limit)
      },
    },
  }
}

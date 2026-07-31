import { AppError } from '../../../common/errors/app.error.js'
import { buildPaginationMeta, resolvePagingQuery } from '../../../common/utils/pagination.js'
import type { OrderRepository } from '../../sales/infrastructure/order.repository.js'
import type { UserRepository } from '../../identity/infrastructure/user.repository.js'
import type { OrderEntity } from '../../sales/domain/order.entity.js'
import { renderOrderInvoiceHtml } from '../templates/order-invoice.template.js'

function serializeOrderListItem(o: OrderEntity, userMap: Map<string, { name: string; email: string }>) {
  return {
    id: o._id,
    orderNumber: o.orderNumber,
    userId: o.userId,
    userEmail: o.email ?? userMap.get(o.userId ?? '')?.email ?? null,
    userName: o.customerName || userMap.get(o.userId ?? '')?.name || null,
    phone: o.phone,
    items: o.items,
    total: o.total,
    status: o.status,
    paymentStatus: o.paymentStatus,
    createdAt: o.createdAt instanceof Date ? o.createdAt.toISOString() : o.createdAt,
    cancellationRequested: o.cancellationRequested ?? false,
    cancellationRequestStatus: o.cancellationRequestStatus ?? null,
    cancellationRequestReason: o.cancellationRequestReason ?? null,
    cancelledBy: o.cancelledBy ?? null,
  }
}

export class AdminOrderService {
  constructor(
    private readonly orders: OrderRepository,
    private readonly users: UserRepository,
  ) {}

  async list(query: Record<string, unknown>) {
    const { page, limit, skip, search } = resolvePagingQuery(query, { defaultLimit: 20, maxLimit: 100 })
    const [orderList, total] = await Promise.all([
      this.orders.listAllAdmin(skip, limit, search || undefined),
      this.orders.countAllAdmin(search || undefined),
    ])

    const userIds = orderList.filter((o) => o.userId).map((o) => o.userId!)
    const userMap = new Map<string, { name: string; email: string }>()
    if (userIds.length) {
      const users = await this.users.findByIds(userIds)
      for (const u of users) {
        userMap.set(u._id!, { name: u.name ?? u.email, email: u.email })
      }
    }

    const items = orderList.map((o) => serializeOrderListItem(o, userMap))
    return { orders: items, items, pagination: buildPaginationMeta(total, page, limit) }
  }

  async get(id: string) {
    const order = await this.orders.findEntityById(id)
    if (!order) throw AppError.notFound('Orden no encontrada')

    let userAccount: Record<string, unknown> | null = null
    if (order.userId) {
      const user = await this.users.findByIdSafe(order.userId)
      if (user) {
        userAccount = {
          name: user.name,
          email: user.email,
          createdAt: user.createdAt?.toISOString(),
        }
      }
    }

    const rawEvents = order.events ?? []
    const hasOrderCreated = rawEvents.some((e) => e.type === 'order.created')
    const timelineEvents = [
      ...(hasOrderCreated
        ? []
        : [
            {
              type: 'order.created',
              timestamp: order.createdAt instanceof Date ? order.createdAt.toISOString() : String(order.createdAt),
              source: 'system',
              actorId: null,
              data: null,
            },
          ]),
      ...rawEvents.map((e) => ({
        type: e.type,
        timestamp: e.timestamp instanceof Date ? e.timestamp.toISOString() : String(e.timestamp),
        source: e.source,
        actorId: e.actorId ?? null,
        data: e.data ?? null,
      })),
    ]

    return {
      order: {
        id: order._id,
        orderNumber: order.orderNumber ?? null,
        status: order.status,
        paymentStatus: order.paymentStatus ?? null,
        fulfillmentStatus: order.fulfillmentStatus ?? null,
        paymentMethod: order.paymentMethod ?? null,
        currency: order.currency ?? 'COP',
        total: order.total,
        subtotal: order.subtotal ?? 0,
        shippingCost: order.shippingCost ?? 0,
        discountAmount: order.discountAmount ?? 0,
        tax: order.tax ?? 0,
        customerName: order.customerName,
        phone: order.phone,
        email: order.email ?? null,
        notes: order.notes ?? null,
        userId: order.userId ?? null,
        address: order.address,
        city: order.city,
        reference: order.reference,
        createdAt: order.createdAt instanceof Date ? order.createdAt.toISOString() : order.createdAt,
        updatedAt: order.updatedAt instanceof Date ? order.updatedAt.toISOString() : null,
        cancellationReason: order.cancellationReason ?? null,
        cancelledAt: order.cancelledAt instanceof Date ? order.cancelledAt.toISOString() : null,
        cancelledBy: order.cancelledBy ?? null,
        cancellationRequested: order.cancellationRequested ?? false,
        cancellationRequestedAt: order.cancellationRequestedAt instanceof Date ? order.cancellationRequestedAt.toISOString() : null,
        cancellationRequestReason: order.cancellationRequestReason ?? null,
        cancellationRequestStatus: order.cancellationRequestStatus ?? null,
        items: order.items,
        events: timelineEvents,
        userAccount,
        depositPercentage: order.depositPercentage ?? null,
        depositAmount: order.depositAmount ?? null,
        depositPaidAt: order.depositPaidAt instanceof Date ? order.depositPaidAt.toISOString() : null,
        finalPaymentAmount: order.finalPaymentAmount ?? null,
        finalPaymentPaidAt: order.finalPaymentPaidAt instanceof Date ? order.finalPaymentPaidAt.toISOString() : null,
        paidAt: order.paidAt instanceof Date ? order.paidAt.toISOString() : null,
      },
    }
  }

  async patch(
    id: string,
    patch: {
      status?: OrderEntity['status']
      paymentStatus?: OrderEntity['paymentStatus']
      notes?: string
      cancellationReason?: string
    },
    actorId: string,
  ) {
    const updated = await this.orders.adminPatch(id, patch, actorId)
    if (!updated) throw AppError.notFound('Orden no encontrada')
    return {
      order: {
        id: updated._id,
        orderNumber: updated.orderNumber ?? null,
        status: updated.status,
        paymentStatus: updated.paymentStatus,
        total: updated.total,
        currency: updated.currency ?? 'COP',
        customerName: updated.customerName,
        notes: updated.notes ?? null,
        updatedAt: updated.updatedAt instanceof Date ? updated.updatedAt.toISOString() : new Date().toISOString(),
      },
    }
  }

  async resolveCancellation(
    id: string,
    resolution: 'approved' | 'rejected' | 'info_needed',
    actorId: string,
    adminNote?: string,
  ) {
    const updated = await this.orders.resolveCancellationRequest(id, resolution, actorId, adminNote)
    if (!updated) throw AppError.notFound('Orden no encontrada')
    return { ok: true, order: { id: updated._id, status: updated.status, cancellationRequestStatus: updated.cancellationRequestStatus } }
  }

  async configureDeposit(id: string, percentage: number, actorId: string) {
    const order = await this.orders.findEntityById(id)
    if (!order) throw AppError.notFound('Orden no encontrada')
    if (order.paymentStatus === 'paid' || order.paymentStatus === 'payment_completed') {
      throw AppError.badRequest('La orden ya está pagada por completo')
    }
    const updated = await this.orders.configureDeposit(id, percentage, actorId)
    if (!updated) throw AppError.notFound('Orden no encontrada')
    return { ok: true, message: `Anticipo del ${percentage}% configurado correctamente` }
  }

  async markDepositPaid(id: string, amount: number, actorId: string, note?: string) {
    const order = await this.orders.findEntityById(id)
    if (!order) throw AppError.notFound('Orden no encontrada')
    if (!order.depositPercentage) {
      throw AppError.badRequest('Esta orden no tiene configurado un plan de anticipo')
    }
    if (order.paymentStatus === 'final_payment_pending' || order.depositPaidAt) {
      throw AppError.badRequest('El anticipo ya fue pagado')
    }
    const updated = await this.orders.markDepositPaid(id, amount, actorId, note)
    if (!updated) throw AppError.notFound('Orden no encontrada')
    return { ok: true, message: 'Anticipo registrado como pagado' }
  }

  async markFinalPaymentPaid(id: string, amount: number, actorId: string, note?: string) {
    const order = await this.orders.findEntityById(id)
    if (!order) throw AppError.notFound('Orden no encontrada')
    if (order.paymentStatus !== 'final_payment_pending') {
      throw AppError.badRequest('El pago final solo puede registrarse cuando el anticipo ya fue pagado')
    }
    const updated = await this.orders.markFinalPaymentPaid(id, amount, actorId, note)
    if (!updated) throw AppError.notFound('Orden no encontrada')
    return { ok: true, message: 'Pago final registrado correctamente' }
  }

  async renderInvoice(id: string) {
    const order = await this.orders.findEntityById(id)
    if (!order) throw AppError.notFound('Orden no encontrada')
    const html = renderOrderInvoiceHtml(order, id)
    const orderNumber = order.orderNumber || id.slice(0, 8)
    return { html, filename: `factura-${orderNumber.replace(/[^a-zA-Z0-9]/g, '-')}.html` }
  }
}

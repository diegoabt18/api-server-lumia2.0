import { AppError } from '../../../common/errors/app.error.js'
import type { InventoryRepository } from '../../catalog/infrastructure/inventory.repository.js'
import type { MailService } from '../../notifications/services/mail.service.js'
import type { PushService } from '../../notifications/services/push.service.js'
import type { ManualPaymentService } from '../../payments/services/manual-payment.service.js'
import type { CartRepository } from '../infrastructure/cart.repository.js'
import type { OrderRepository } from '../infrastructure/order.repository.js'
import type { CreateOrderDto } from '../schemas/order.schema.js'
import type { CheckoutShippingDto } from '../schemas/checkout.schema.js'
import { signOrderAccessToken } from '../utils/order-access-token.utils.js'
import type { CartItemEntity } from '../domain/cart.entity.js'
import type { OrderItemEntity } from '../domain/order.entity.js'

function mapCartItemsToOrderItems(items: CartItemEntity[]): OrderItemEntity[] {
  return items.map((i) => ({
    productId: i.productSlug,
    productSlug: i.productSlug,
    variantSku: i.sku,
    variantName: i.variantLabel,
    name: i.productName,
    quantity: i.quantity,
    unitPrice: i.unitPrice,
    subtotal: i.unitPrice * i.quantity,
    selectionLabel: i.variantLabel,
    imageUrl: i.imagePath ?? undefined,
  }))
}

export function toOrderSummary(order: Awaited<ReturnType<OrderRepository['findByIdSafe']>>) {
  if (!order) return null
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    paymentStatus: order.paymentStatus ?? 'unpaid',
    paymentMethod: undefined as string | undefined,
    total: order.total,
    currency: order.currency ?? 'COP',
    customerName: order.customerName,
    phone: order.phone,
    email: order.email,
    address: order.address,
    city: order.city,
    reference: order.reference,
    notes: order.notes,
    subtotal: order.subtotal ?? order.total,
    shippingCost: order.shippingCost ?? 0,
    items: order.items.map((i) => ({
      sku: i.variantSku ?? i.productSlug ?? '',
      productSlug: i.productSlug,
      name: i.name,
      variantLabel: i.variantName ?? i.selectionLabel,
      quantity: i.quantity,
      unitPrice: i.unitPrice,
      subtotal: i.subtotal,
      imagePath: i.imageUrl ?? null,
    })),
    createdAt: order.createdAt,
  }
}

export class OrderService {
  constructor(
    private readonly orders: OrderRepository,
    private readonly carts: CartRepository,
    private readonly inventory: InventoryRepository,
    private readonly manualPayments: ManualPaymentService,
    private readonly mail: MailService,
    private readonly push: PushService,
  ) {}

  private async validateCartInventory(items: CartItemEntity[]) {
    for (const item of items) {
      const inv = await this.inventory.getBySku(item.sku)
      if (!inv) continue
      if (inv.isPerOrder) continue
      if (inv.available <= 0) {
        throw AppError.badRequest(`Sin stock disponible para ${item.productName}`)
      }
      if (item.quantity > inv.available) {
        throw AppError.badRequest(
          `Cantidad máxima disponible para ${item.productName}: ${inv.available}`,
        )
      }
    }
  }

  async create(dto: CreateOrderDto, userId: string | null, email: string | null) {
    const subtotal =
      dto.subtotal ??
      dto.items.reduce((sum, item) => sum + item.subtotal, 0)

    const order = await this.orders.createOrder({
      userId,
      email: dto.email ?? email,
      customerName: dto.customerName,
      phone: dto.phone,
      whatsapp: dto.whatsapp,
      address: dto.address,
      city: dto.city,
      reference: dto.reference,
      notes: dto.notes,
      items: dto.items,
      subtotal,
      shippingCost: dto.shippingCost ?? 0,
      tax: dto.tax ?? 0,
      discountAmount: dto.discountAmount ?? 0,
      total: dto.total,
      status: 'pending',
      paymentStatus: 'unpaid',
      fulfillmentStatus: 'unfulfilled',
      currency: dto.currency,
      paymentMethod: dto.paymentMethod,
    })

    return {
      ...order,
      accessToken: signOrderAccessToken(order.id),
    }
  }

  async createFromCheckout(
    cartKey: string,
    shipping: CheckoutShippingDto,
    userId: string | null,
    userEmail: string | null,
  ) {
    const cart = await this.carts.findByKey(cartKey)
    if (!cart?.items.length) throw AppError.badRequest('El carrito está vacío')

    await this.validateCartInventory(cart.items)

    const items = mapCartItemsToOrderItems(cart.items)
    const subtotal = items.reduce((s, i) => s + i.subtotal, 0)
    const shippingCost = 0
    const total = subtotal + shippingCost
    const email = shipping.email ?? userEmail

    const order = await this.orders.createOrder({
      userId,
      email: email ?? null,
      customerName: shipping.customerName,
      phone: shipping.phone,
      address: shipping.address,
      city: shipping.city,
      reference: shipping.reference,
      notes: shipping.notes,
      items,
      subtotal,
      shippingCost,
      tax: 0,
      discountAmount: 0,
      total,
      status: 'pending',
      paymentStatus: 'unpaid',
      fulfillmentStatus: 'unfulfilled',
      currency: cart.items[0]?.currency ?? 'COP',
      paymentMethod: 'manual',
      events: [
        {
          type: 'order.created',
          timestamp: new Date(),
          source: 'system',
          data: { total, itemCount: items.length, source: 'cart' },
        },
      ],
    })

    const payment = await this.manualPayments.createForOrder(order.id, {
      cartKey,
      userId,
    })

    void this.mail.notifyPreOrderCreated(order)
    void this.push.notifyPreOrderCreated(order)

    return {
      id: order.id,
      orderNumber: order.orderNumber,
      total: order.total,
      paymentStatus: payment.paymentStatus,
      accessToken: signOrderAccessToken(order.id),
    }
  }

  async getById(id: string, userId?: string | null) {
    if (userId) {
      const owned = await this.orders.findByUser(userId, id)
      if (owned) return toOrderSummary(owned)
    }
    const order = await this.orders.findByIdSafe(id)
    if (!order) throw AppError.notFound('Order not found')
    return toOrderSummary(order)
  }

  async listMine(userId: string) {
    const orders = await this.orders.listByUser(userId)
    return { orders: orders.map((o) => toOrderSummary(o)!) }
  }

  async getByAccessToken(token: string) {
    const { verifyOrderAccessToken } = await import('../utils/order-access-token.utils.js')
    const orderId = verifyOrderAccessToken(token)
    const order = await this.orders.findByIdSafe(orderId)
    if (!order) throw AppError.notFound('Order not found')
    return toOrderSummary(order)
  }

  async getIdByOrderNumber(orderNumber: string) {
    const order = await this.orders.findByOrderNumber(orderNumber)
    if (!order) throw AppError.notFound('Order not found')
    return { id: order.id }
  }

  async cancel(orderId: string, userId: string, reason?: string) {
    const order = await this.orders.findByUser(userId, orderId)
    if (!order) throw AppError.notFound('Pedido no encontrado')

    if (order.paymentStatus === 'paid' || order.status === 'paid') {
      throw AppError.badRequest(
        'No puedes cancelar un pedido ya pagado. Usa "Solicitar cancelación".',
      )
    }
    if (order.status === 'cancelled') {
      throw AppError.badRequest('Este pedido ya está cancelado.')
    }
    if (order.status === 'shipped' || order.status === 'delivered') {
      throw AppError.badRequest('No puedes cancelar un pedido que ya fue enviado.')
    }

    await this.orders.cancelOrder(orderId, {
      cancellationReason: reason?.trim() || 'Cancelado por el cliente',
      cancelledBy: 'customer',
    })

    return { success: true, message: 'Pedido cancelado exitosamente' }
  }

  async requestCancellation(orderId: string, userId: string, reason: string) {
    const order = await this.orders.findByUser(userId, orderId)
    if (!order) throw AppError.notFound('Pedido no encontrado')

    if (['cancelled', 'delivered', 'expired'].includes(order.status)) {
      throw AppError.badRequest(
        `No se puede solicitar cancelación de un pedido en estado "${order.status}"`,
      )
    }

    if (order.cancellationRequested) {
      throw AppError.badRequest(
        'Ya existe una solicitud de cancelación pendiente para este pedido',
      )
    }

    await this.orders.requestCancellation(orderId, reason)

    return {
      ok: true,
      message: 'Solicitud de cancelación recibida. El equipo revisará tu solicitud.',
    }
  }
}

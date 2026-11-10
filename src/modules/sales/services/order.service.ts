import { AppError } from '../../../common/errors/app.error.js'
import type { InventoryRepository } from '../../catalog/infrastructure/inventory.repository.js'
import type { MailService } from '../../notifications/services/mail.service.js'
import type { PushService } from '../../notifications/services/push.service.js'
import type { ManualPaymentService } from '../../payments/services/manual-payment.service.js'
import type { CartRepository } from '../infrastructure/cart.repository.js'
import type { OrderRepository } from '../infrastructure/order.repository.js'
import type { ProductRepository } from '../../catalog/infrastructure/product.repository.js'
import type { CreateOrderDto } from '../schemas/order.schema.js'
import type { CheckoutShippingDto } from '../schemas/checkout.schema.js'
import { signOrderAccessToken } from '../utils/order-access-token.utils.js'
import type { CartItemEntity } from '../domain/cart.entity.js'
import type { FulfillmentMode, OrderItemEntity } from '../domain/order.entity.js'
import type { DepositPolicy } from '../../catalog/domain/deposit-policy.js'
import { calculateOrderFinancials, PricingConfigError } from '../domain/order-financials.js'
import type { AppLogger } from '../../../config/logger.js'

/** Mensaje para el cliente. El detalle técnico queda solo en el log del servidor. */
export const PRICING_UNAVAILABLE_MESSAGE =
  'No podemos calcular el pago de tu pedido en este momento. Intenta de nuevo más tarde.'

/** Fuente de costo de materiales: hojas de costo de producción (por SKU de variante). */
export interface MaterialCostSource {
  getLatestByVariantSku(variantSku: string): Promise<{ materialsCost: number } | null>
}

export interface LineFulfillmentSnapshot {
  fulfillmentMode: FulfillmentMode
  depositPolicy: DepositPolicy | null
}

/**
 * Rechaza importes enviados por el cliente que no coinciden con el cálculo de Server.
 * No se corrige en silencio: un total distinto significaría cobrar un importe no confirmado.
 */
function assertClientAmountMatches(clientAmount: number, serverAmount: number, field: 'total' | 'subtotal') {
  if (Math.abs(clientAmount - serverAmount) >= 0.005) {
    throw AppError.badRequest(
      `El ${field} enviado (${clientAmount}) no coincide con el calculado por el servidor (${serverAmount}). Actualiza el carrito e inténtalo de nuevo.`,
    )
  }
}

/**
 * Convierte el carrito en líneas de pedido. La modalidad y la política de anticipo se fotografían
 * aquí desde inventario: un SKU sin registro se trata como `stock` sin política.
 */
export function mapCartItemsToOrderItems(
  items: CartItemEntity[],
  taxRates: Map<string, number | null> = new Map(),
  fulfillment: Map<string, LineFulfillmentSnapshot> = new Map(),
): OrderItemEntity[] {
  return items.map((i) => ({
    productId: i.productSlug,
    taxRate: taxRates.get(i.productSlug) ?? null,
    fulfillmentMode: fulfillment.get(i.sku)?.fulfillmentMode ?? 'stock',
    depositPolicy: fulfillment.get(i.sku)?.depositPolicy ?? null,
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
  // Pedidos anteriores al libro de pagos: si ya están pagados, el total cuenta como pagado.
  const paidAmount = order.paidAmount ?? (order.status === 'paid' ? order.total : 0)
  const balanceDue = order.balanceDue ?? Math.max(0, Math.round((order.total - paidAmount) * 100) / 100)
  return {
    initialPaymentRequired: order.initialPaymentRequired ?? order.total,
    paidAmount,
    balanceDue,
    id: order.id,
    orderNumber: order.orderNumber,
    customerReference: order.customerReference ?? order.orderNumber,
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
      fulfillmentMode: i.fulfillmentMode ?? 'stock',
      initialPaymentRequired: i.initialPaymentRequired ?? i.subtotal,
      paidAmount: i.paidAmount ?? (order.status === 'paid' ? i.subtotal : 0),
      balanceDue: i.balanceDue ?? (order.status === 'paid' ? 0 : i.subtotal),
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
    private readonly products: ProductRepository,
    private readonly costSheets?: MaterialCostSource,
    private readonly logger?: AppLogger,
  ) {}

  private async validateCartInventory(items: Array<Pick<CartItemEntity, 'sku' | 'productName' | 'quantity'>>) {
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

  /** Fotografía modalidad y política desde el inventario de Server. Un SKU sin registro es `stock`. */
  private async loadFulfillment(skus: string[]): Promise<Map<string, LineFulfillmentSnapshot>> {
    const snapshots = new Map<string, LineFulfillmentSnapshot>()
    for (const sku of new Set(skus)) {
      const inv = await this.inventory.getBySku(sku)
      if (!inv) continue
      snapshots.set(sku, {
        fulfillmentMode: inv.isPerOrder ? 'made_to_order' : 'stock',
        depositPolicy: inv.depositPolicy,
      })
    }
    return snapshots
  }

  /**
   * Costo de materiales de una línea para la política `materials`: costo por unidad de la hoja de
   * costo vigente del SKU (producción), multiplicado por la cantidad. Sin hoja → undefined, y el
   * cálculo bloquea el pedido con un error explicativo. Solo se consulta cuando hace falta.
   */
  private async materialCostForLine(item: {
    variantSku?: string
    quantity: number
    fulfillmentMode: FulfillmentMode
    depositPolicy: DepositPolicy | null
  }): Promise<number | undefined> {
    if (item.fulfillmentMode !== 'made_to_order' || item.depositPolicy?.type !== 'materials') return undefined
    if (!item.variantSku || !this.costSheets) return undefined
    const sheet = await this.costSheets.getLatestByVariantSku(item.variantSku)
    if (!sheet || !Number.isFinite(sheet.materialsCost)) return undefined
    return Math.round(sheet.materialsCost * item.quantity * 100) / 100
  }

  /**
   * Aplica la fotografía de modalidad/política y calcula pago inicial y saldo por línea y de pedido.
   * Es el único punto donde se decide cuánto se cobra al inicio.
   */
  private async finalizeItems(items: OrderItemEntity[], fulfillment: Map<string, LineFulfillmentSnapshot>) {
    const withFulfillment = items.map((item) => {
      const snapshot = item.variantSku ? fulfillment.get(item.variantSku) : undefined
      return {
        ...item,
        fulfillmentMode: snapshot?.fulfillmentMode ?? 'stock',
        depositPolicy: snapshot?.depositPolicy ?? null,
      }
    })
    const pricedLines = await Promise.all(
      withFulfillment.map(async (item) => ({
        label: item.name,
        sku: item.variantSku,
        quantity: item.quantity,
        lineTotal: item.subtotal,
        fulfillmentMode: item.fulfillmentMode,
        depositPolicy: item.depositPolicy,
        materialCost: await this.materialCostForLine(item),
      })),
    )
    let financials: ReturnType<typeof calculateOrderFinancials>
    try {
      financials = calculateOrderFinancials(pricedLines)
    } catch (error) {
      if (error instanceof PricingConfigError) {
        // Problema de configuración del catálogo: se registra con detalle para el administrador.
        this.logger?.error(
          { reason: error.reason, sku: error.sku, product: error.label },
          `Configuración de precios incompleta: ${error.message}`,
        )
        throw new AppError(503, PRICING_UNAVAILABLE_MESSAGE, 'PRICING_UNAVAILABLE')
      }
      throw error
    }
    const finalItems: OrderItemEntity[] = withFulfillment.map((item, index) => ({
      ...item,
      initialPaymentRequired: financials.lines[index]!.initialPaymentRequired,
      balanceDue: financials.lines[index]!.balanceDue,
    }))
    return { items: finalItems, financials }
  }

  /**
   * Ruta `dto.items`: el cliente solo indica SKU y cantidad. Precio, modalidad y política
   * se resuelven en Server; los importes enviados por el cliente se comparan, no se usan.
   */
  private async priceDtoItems(dtoItems: CreateOrderDto['items']): Promise<OrderItemEntity[]> {
    const priced: OrderItemEntity[] = []
    for (const item of dtoItems) {
      if (!item.variantSku) {
        throw AppError.badRequest(`Falta la variante (SKU) de "${item.name}".`)
      }
      const product = await this.products.findBySlugOrId(item.productSlug ?? item.productId)
      const variant = product?.variants?.find((v) => v.sku === item.variantSku)
      if (!product || !variant || variant.price == null) {
        throw AppError.badRequest(`"${item.name}" no está disponible para la venta.`)
      }
      priced.push({
        productId: item.productId,
        productSlug: product.slug,
        variantSku: variant.sku,
        variantName: item.variantName,
        name: product.name,
        quantity: item.quantity,
        unitPrice: variant.price,
        subtotal: variant.price * item.quantity,
        selectionLabel: item.selectionLabel,
        imageUrl: item.imageUrl,
      })
    }
    return priced
  }

  async create(dto: CreateOrderDto, userId: string | null, email: string | null) {
    if ((dto.shippingCost ?? 0) !== 0 || (dto.tax ?? 0) !== 0 || (dto.discountAmount ?? 0) !== 0) {
      throw AppError.badRequest('Envío, impuestos y descuentos los calcula el servidor.')
    }

    const pricedItems = await this.priceDtoItems(dto.items)
    await this.validateCartInventory(
      pricedItems.map((i) => ({ sku: i.variantSku!, productName: i.name, quantity: i.quantity })),
    )
    const fulfillment = await this.loadFulfillment(pricedItems.map((i) => i.variantSku!))
    const { items, financials } = await this.finalizeItems(pricedItems, fulfillment)

    assertClientAmountMatches(dto.total, financials.total, 'total')
    if (dto.subtotal !== undefined) assertClientAmountMatches(dto.subtotal, financials.total, 'subtotal')

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
      items,
      subtotal: financials.total,
      shippingCost: 0,
      tax: 0,
      discountAmount: 0,
      total: financials.total,
      initialPaymentRequired: financials.initialPaymentRequired,
      paidAmount: 0,
      balanceDue: financials.balanceDue,
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

    const taxRates = await this.products.findTaxRatesBySlugs(cart.items.map((i) => i.productSlug))
    const fulfillment = await this.loadFulfillment(cart.items.map((i) => i.sku))
    const { items, financials } = await this.finalizeItems(
      mapCartItemsToOrderItems(cart.items, taxRates, fulfillment),
      fulfillment,
    )
    const shippingCost = 0
    const total = financials.total
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
      subtotal: total,
      shippingCost,
      tax: 0,
      discountAmount: 0,
      total,
      initialPaymentRequired: financials.initialPaymentRequired,
      paidAmount: 0,
      balanceDue: financials.balanceDue,
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
          data: {
            total,
            itemCount: items.length,
            source: 'cart',
            initialPaymentRequired: financials.initialPaymentRequired,
            balanceDue: financials.balanceDue,
          },
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
      customerReference: order.customerReference,
      total: order.total,
      initialPaymentRequired: financials.initialPaymentRequired,
      balanceDue: financials.balanceDue,
      paymentStatus: payment.paymentStatus,
      accessToken: signOrderAccessToken(order.id),
    }
  }

  /**
   * Cotización financiera autoritativa del carrito, sin crear pedido ni pago. Usa exactamente el
   * mismo cálculo que el checkout: precios del carrito, modalidad y política desde inventario.
   */
  async quoteFromCart(cartKey: string | null) {
    const empty = {
      currency: 'COP',
      total: 0,
      initialPaymentRequired: 0,
      balanceDue: 0,
      items: [] as Array<Record<string, unknown>>,
    }
    if (!cartKey) return empty
    const cart = await this.carts.findByKey(cartKey)
    if (!cart?.items.length) return empty

    const fulfillment = await this.loadFulfillment(cart.items.map((i) => i.sku))
    const { items, financials } = await this.finalizeItems(
      mapCartItemsToOrderItems(cart.items, new Map(), fulfillment),
      fulfillment,
    )
    return {
      currency: cart.items[0]?.currency ?? 'COP',
      total: financials.total,
      initialPaymentRequired: financials.initialPaymentRequired,
      balanceDue: financials.balanceDue,
      items: items.map((i) => ({
        sku: i.variantSku ?? i.productSlug ?? '',
        name: i.name,
        variantLabel: i.variantName ?? i.selectionLabel ?? null,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
        subtotal: i.subtotal,
        fulfillmentMode: i.fulfillmentMode ?? 'stock',
        initialPaymentRequired: i.initialPaymentRequired ?? i.subtotal,
        balanceDue: i.balanceDue ?? 0,
      })),
    }
  }

  /**
   * Detalle completo solo para el dueño del pedido. Para cualquier otro caso responde 404 (no revela
   * si el pedido existe). Los invitados usan la vista pública limitada o el token de acceso.
   */
  async getById(id: string, userId?: string | null) {
    if (!userId) throw AppError.notFound('Order not found')
    const owned = await this.orders.findByUser(userId, id)
    if (!owned) throw AppError.notFound('Order not found')
    return toOrderSummary(owned)
  }

  /** Vista pública mínima (sin datos personales): estado y referencias. */
  async getPublicView(id: string) {
    const order = await this.orders.findByIdSafe(id)
    if (!order) throw AppError.notFound('Order not found')
    return {
      id: order.id,
      orderNumber: order.orderNumber,
      customerReference: order.customerReference ?? order.orderNumber,
      status: order.status,
      paymentStatus: order.paymentStatus,
    }
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

  /** Resuelve número o referencia corta solo para su dueño autenticado. Para otros: 404. */
  async getIdByOrderNumber(orderNumber: string, userId?: string | null) {
    const order = userId ? await this.orders.findByOrderNumber(orderNumber) : null
    if (!order || order.userId !== userId) throw AppError.notFound('Order not found')
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
    // Un abono ya recibido no se cancela en silencio: requiere revisión y devolución.
    if ((order.paidAmount ?? 0) > 0) {
      throw AppError.badRequest(
        'El pedido tiene pagos registrados. Usa "Solicitar cancelación" para que el equipo revise la devolución.',
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

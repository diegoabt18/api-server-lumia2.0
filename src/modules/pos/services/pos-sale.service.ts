import { AppError } from '../../../common/errors/app.error.js'
import type { InventoryRepository } from '../../catalog/infrastructure/inventory.repository.js'
import type { ProductRepository } from '../../catalog/infrastructure/product.repository.js'
import type { PromotionRepository } from '../../catalog/infrastructure/promotion.repository.js'
import type { VariantDomain } from '../../catalog/domain/catalog.entity.js'
import type { UserEntity } from '../../identity/domain/user.entity.js'
import type { UserRepository } from '../../identity/infrastructure/user.repository.js'
import type { PosCustomerRepository } from '../../identity/infrastructure/pos-customer.repository.js'
import type { PaymentRepository } from '../../payments/infrastructure/payment.repository.js'
import {
  resolvePaymentMethodDisplay,
  type PaymentMethod,
} from '../../payments/domain/payment-method.js'
import {
  createPaymentEntity,
  type PaymentMethod as PaymentEntityMethod,
} from '../../payments/domain/payment.types.js'
import { paymentStatusForPosSale } from '../domain/pos-payment-status.js'
import type { OrderEntity } from '../../sales/domain/order.entity.js'
import type { OrderRepository } from '../../sales/infrastructure/order.repository.js'
import type { OrderPaymentService } from '../../sales/services/order-payment.service.js'
import { nextRequiredPayment } from '../../sales/domain/order-payment-ledger.js'
import type { FinancialOutboxRepository } from '../../sales/infrastructure/financial-outbox.repository.js'
import {
  buildPosPaymentEventKey,
  buildPosSaleEventKey,
} from '../../sales/domain/financial-event.entity.js'
import { buildOrderFinancialPayload, OrderFinancialEvents } from '../../sales/services/order-financial-events.service.js'
import type { StoreSettingsRepository } from '../../store/infrastructure/store-settings.repository.js'
import {
  applyPercentToPrice,
  resolveBestPromotionForProductFromEntities,
} from '../../pricing/promotion.service.js'
import type { PosSaleDto } from '../schemas/pos.schema.js'
import {
  toPosSaleView,
  type PosActor,
  type PosCustomerView,
  type PosPaymentConfig,
  type PosPaymentMethodView,
  type PosProductView,
  type PosSaleLine,
  type PosSaleResult,
  type PosSaleView,
} from '../domain/pos.entity.js'

const CONSUMER_FINAL = 'Consumidor final'
const POS_ADDRESS = 'Venta presencial en tienda'
const POS_CITY = 'Tienda'
const POS_REFERENCE = 'POS'
const MAX_ITEMS = 100
/** POS only accepts in-store settlement methods; online redirect methods are excluded. */
const POS_PAYMENT_METHOD_IDS = new Set(['cash', 'bank_transfer'])

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function isDuplicateKey(error: unknown): boolean {
  return (error as { code?: number } | null)?.code === 11000
}

function variantLabel(variant: VariantDomain): string {
  const description = variant.description?.trim()
  if (description) return description
  const options = Object.values(variant.options ?? {}).filter(Boolean)
  return options.length ? options.join(' · ') : variant.sku
}

function primaryAddress(user: UserEntity) {
  const addresses = user.shippingAddresses ?? []
  return addresses.find((address) => address.isPrimary) ?? addresses[0] ?? null
}

function normalizeBarcode(value: string): string {
  return value.trim()
}

export class PosSaleService {
  constructor(
    private readonly orders: OrderRepository,
    private readonly products: ProductRepository,
    private readonly inventory: InventoryRepository,
    private readonly promotions: PromotionRepository,
    private readonly users: UserRepository,
    private readonly payments: PaymentRepository,
    private readonly storeSettings: StoreSettingsRepository,
    private readonly posCustomers: PosCustomerRepository,
    private readonly outbox: FinancialOutboxRepository,
    private readonly orderPayments: OrderPaymentService,
  ) {}

  /**
   * Encola los hechos financieros de una orden POS. Es idempotente (eventKey único), así que
   * puede llamarse en cada reintento. Un fallo aquí no revierte la venta, porque el stock y la
   * orden ya están confirmados; el siguiente replay de la misma clave de idempotencia lo reintenta.
   */
  private async recordFinancialEvents(order: OrderEntity): Promise<void> {
    // Events must never fail the sale: any error here is logged, not propagated.
    try {
      await this.writeFinancialEvents(order)
    } catch (error) {
      console.error('[pos] evento financiero omitido', { orderId: order._id, error })
    }
  }

  private async writeFinancialEvents(order: OrderEntity): Promise<void> {
    if (!order._id) return
    const base = {
      sourceType: 'order' as const,
      sourceId: order._id,
    }
    const payload = buildOrderFinancialPayload(order, order.createdByUserId ?? null)
    try {
      await this.outbox.enqueue({
        ...base,
        eventKey: buildPosSaleEventKey(order._id),
        type: 'pos.sale.recorded',
        occurredAt: order.createdAt,
        payload,
      })
      // Venta POS: el producto se entrega en el mismo acto, así que la entrega también se registra.
      if (order.deliveredAt) {
        await new OrderFinancialEvents(this.outbox).recordDelivered(order, order.createdByUserId ?? null, order.deliveredAt)
      }
      if (order.paymentStatus === 'paid' && order.paymentConfirmedAt) {
        await this.outbox.enqueue({
          ...base,
          eventKey: buildPosPaymentEventKey(order._id),
          type: 'pos.payment.confirmed',
          occurredAt: order.paymentConfirmedAt,
          payload: {
            ...payload,
            lines: undefined,
            cashReceived: order.cashReceived ?? null,
            changeGiven: order.changeGiven ?? null,
            transferReference: order.transferReference ?? null,
            actorId: order.paymentConfirmedByUserId ?? null,
          },
        })
      }
    } catch (error) {
      console.error('[pos] no se pudo encolar el evento financiero', { orderId: order._id, error })
    }
  }

  async getPaymentMethods(): Promise<PosPaymentMethodView[]> {
    // Source of truth: store_payment_settings (enabled state and display text). The code only
    // supplies fallback text for methods whose metadata was never stored.
    const settings = await this.storeSettings.getPaymentSettings()
    return settings.methods
      .filter((method) => method.isActive && POS_PAYMENT_METHOD_IDS.has(method.methodId))
      .map((method) => {
        const display = resolvePaymentMethodDisplay(method.methodId as PaymentMethod, method)
        return {
          methodId: method.methodId,
          displayName: display.displayName,
          description: display.description,
          // Method selection never confirms payment by itself; bank transfers always stay pending
          // until an administrator verifies the deposit.
          supportsPaid: method.methodId === 'cash',
        }
      })
  }

  async getPaymentConfig(): Promise<PosPaymentConfig> {
    const [methods, settings] = await Promise.all([
      this.getPaymentMethods(),
      this.storeSettings.getPaymentSettings(),
    ])
    return {
      methods,
      bankTransferDetails: settings.bankTransferDetails ?? null,
    }
  }

  /**
   * Búsqueda de productos para el POS. Puede buscar por texto, por jerarquía (categoría/subcategoría)
   * o por ambas. Sin texto ni filtro no devuelve nada (evita listar todo el catálogo).
   */
  async searchProducts(
    term: string,
    page: number,
    pageSize: number,
    hierarchy: { categorySlug?: string; subcategoryId?: string; empty?: boolean } = {},
  ): Promise<{ products: PosProductView[]; total: number; page: number; pageSize: number; totalPages: number }> {
    const hasFilter = Boolean(hierarchy.categorySlug || hierarchy.subcategoryId)
    if (hierarchy.empty || (!term.trim() && !hasFilter)) {
      return { products: [], total: 0, page, pageSize, totalPages: 1 }
    }
    const [result, promotions] = await Promise.all([
      this.products.searchForPos(term, page, pageSize, hierarchy),
      this.promotions.findActiveAt(new Date()),
    ])
    const now = new Date()
    const products = result.items.map((product) => {
      const promotion = resolveBestPromotionForProductFromEntities(
        product.slug,
        product.categorySlug ?? null,
        promotions,
        now,
      )
      return {
        id: product.id,
        slug: product.slug,
        name: product.name,
        imagePath: product.imagePath ?? null,
        variants: product.variants.map((variant) => {
          const rows = variant.inventory ?? []
          const isPerOrder = rows.some((row) => row.is_per_order)
          const originalPrice = round2(variant.price)
          return {
            sku: variant.sku,
            label: variantLabel(variant),
            barcode: variant.barcode ?? null,
            price: promotion ? round2(applyPercentToPrice(originalPrice, promotion.percentOff)) : originalPrice,
            originalPrice,
            promotionPercentOff: promotion?.percentOff,
            currency: variant.currency,
            stock: variant.stock,
            available: variant.available,
            tracked: rows.length > 0 && !isPerOrder,
            isPerOrder,
          }
        }),
      }
    })
    return {
      products,
      total: result.total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(result.total / pageSize)),
    }
  }

  async searchCustomers(term: string, limit = 10): Promise<PosCustomerView[]> {
    // POS customers are any user account: staff accounts can also buy in store.
    const { items } = await this.users.listAll(0, limit, {
      type: 'all',
      search: term?.trim() || undefined,
    })
    const accounts: PosCustomerView[] = items.map((user) => {
      const address = primaryAddress(user)
      return {
        id: user._id ?? '',
        name: user.name ?? user.nickname ?? user.email,
        email: user.email ?? null,
        phone: address?.phone ?? null,
        source: 'account',
      }
    })
    // Clientes de mostrador registrados en ventas anteriores, para no volver a capturarlos.
    const counter: PosCustomerView[] = term?.trim()
      ? (await this.posCustomers.search(term, limit)).map((customer) => ({
          id: customer.id,
          name: customer.name,
          email: customer.email,
          phone: customer.phone,
          source: 'counter' as const,
        }))
      : []
    return [...accounts, ...counter].slice(0, limit)
  }

  async assignBarcode(sku: string, barcode: string): Promise<{ sku: string; barcode: string }> {
    const normalized = normalizeBarcode(barcode)
    const variant = await this.products.getVariantBySku(sku)
    if (!variant) throw AppError.notFound('Variante no encontrada')
    const owner = await this.products.findVariantByBarcode(normalized)
    if (owner && owner.sku !== sku) {
      throw AppError.conflict('Ese código de barras ya está asignado a otra variante')
    }
    const updated = await this.products.updateVariantBarcode(sku, normalized)
    if (!updated) throw AppError.notFound('Variante no encontrada')
    return { sku, barcode: normalized }
  }

  async createSale(
    input: PosSaleDto,
    actor: PosActor,
    idempotencyKey: string | undefined,
  ): Promise<PosSaleResult> {
    const key = idempotencyKey?.trim()
    if (!key || key.length < 8) {
      throw AppError.badRequest('Falta la clave de idempotencia de la venta')
    }

    const existing = await this.orders.findByIdempotencyKey(key)
    if (existing) {
      // Reintento de la misma venta: asegurar que sus eventos existen (idempotente).
      await this.recordFinancialEvents(existing)
      return this.toResult(existing, true)
    }

    if (input.items.length > MAX_ITEMS) {
      throw AppError.badRequest(`Una venta no puede superar ${MAX_ITEMS} líneas`)
    }

    const paymentMethod = await this.assertPaymentMethod(input.payment.method)

    // Una transferencia nunca se marca pagada únicamente por seleccionar el método:
    // debe verificarse y confirmarse explícitamente después.
    const paid = input.payment.method === 'bank_transfer' ? false : input.payment.state === 'paid'

    const transferReference =
      input.payment.method === 'bank_transfer'
        ? input.payment.transferReference?.trim() || null
        : null

    const customer = await this.resolveCustomer(input)
    const lines = await this.buildLines(input)
    const currency = this.assertSingleCurrency(lines)
    const subtotal = round2(lines.reduce((sum, line) => sum + line.subtotal, 0))
    const requestedDiscount = round2(input.discountAmount ?? 0)
    if (requestedDiscount < 0 || requestedDiscount > subtotal) {
      throw AppError.badRequest('El descuento no puede superar el subtotal de la venta')
    }
    const discountAmount = requestedDiscount
    const total = round2(subtotal - discountAmount)
    if (total < 0) throw AppError.badRequest('El total de la venta no puede ser negativo')

    const cashReceived =
      input.payment.method === 'cash' && paid
        ? round2(input.payment.cashReceived ?? 0)
        : null
    if (input.payment.method === 'cash' && paid) {
      if (!cashReceived || cashReceived < total) {
        throw AppError.badRequest('El importe recibido en efectivo no puede ser inferior al total')
      }
    }
    const changeGiven =
      input.payment.method === 'cash' && paid && cashReceived !== null
        ? round2(cashReceived - total)
        : null

    await this.assertStock(lines)

    const decremented: PosSaleLine[] = []
    try {
      for (const line of lines) {
        if (!line.tracked) continue
        const ok = await this.inventory.decrementAtomic(line.sku, line.quantity)
        if (!ok) {
          throw AppError.badRequest(
            `Sin existencias suficientes para ${line.name}${line.variantLabel ? ` (${line.variantLabel})` : ''}`,
          )
        }
        decremented.push(line)
      }
    } catch (error) {
      await this.restoreStock(decremented)
      throw error
    }

    const now = new Date()
    const receiptNumber = await this.orders.generatePosOrderNumber()

    let order: OrderEntity
    try {
      order = await this.orders.createPosOrder(
        {
          userId: customer.userId,
          posCustomerId: customer.posCustomerId,
          email: customer.email,
          customerName: customer.name,
          phone: customer.phone,
          whatsapp: customer.phone || undefined,
          address: POS_ADDRESS,
          city: POS_CITY,
          reference: POS_REFERENCE,
          notes: input.notes,
          items: lines.map((line) => ({
            productId: line.productId,
            productSlug: line.productSlug,
            variantSku: line.sku,
            variantName: line.variantLabel,
            name: line.name,
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            subtotal: line.subtotal,
            selectionLabel: line.variantLabel,
            imageUrl: line.imageUrl ?? undefined,
            originalUnitPrice: line.originalUnitPrice,
            promotionPercentOff: line.promotionPercentOff,
            promotionId: line.promotionId,
            taxRate: line.taxRate ?? null,
          })),
          subtotal,
          shippingCost: 0,
          tax: 0,
          discountAmount,
          total,
          // G3: venta POS con pago inicial = total; el saldo se liquida con pagos registrados.
          initialPaymentRequired: total,
          paidAmount: paid ? total : 0,
          balanceDue: paid ? 0 : total,
          status: paid ? 'paid' : 'pending',
          paymentStatus: paid ? 'paid' : 'pending_manual',
          fulfillmentStatus: 'delivered',
          channel: 'pos',
          fulfillment: 'in_store',
          // El stock de la venta POS se descontó al crearla: una cancelación posterior debe devolverlo.
          stockDecrementedAt: now,
          createdByUserId: actor.userId,
          idempotencyKey: key,
          currency,
          paymentMethod: paymentMethod.methodId,
          cashReceived,
          changeGiven,
          transferReference,
          paymentConfirmedByUserId: paid ? actor.userId : null,
          paymentConfirmedAt: paid ? now : null,
          paidAt: paid ? now : null,
          deliveredAt: now,
          events: [
            {
              type: 'order.created',
              timestamp: now,
              source: 'admin',
              actorId: actor.userId,
              data: { channel: 'pos', total, itemCount: lines.length, receiptNumber },
            },
            {
              type: paid ? 'payment.manual_confirmed' : 'payment.manual_pending',
              timestamp: now,
              source: 'admin',
              actorId: actor.userId,
              data: { paymentMethod: paymentMethod.methodId, total, cashReceived, changeGiven, transferReference },
            },
            {
              type: 'order.delivered',
              timestamp: now,
              source: 'admin',
              actorId: actor.userId,
              data: { fulfillment: 'in_store' },
            },
          ],
        },
        receiptNumber,
      )
    } catch (error) {
      await this.restoreStock(decremented)
      if (isDuplicateKey(error)) {
        const duplicate = await this.orders.findByIdempotencyKey(key)
        if (duplicate) return this.toResult(duplicate, true)
      }
      throw error
    }

    try {
      const payment = createPaymentEntity({
        orderId: order._id!,
        attemptNumber: 1,
        externalReference: `pos-${order._id}-1`,
        amount: total,
        currency,
        // Real in-store method (cash | bank_transfer), not a generic 'manual' label.
        paymentMethod: paymentMethod.methodId as PaymentEntityMethod,
        providerPreferenceId: `pos-${order._id}`,
        status: paymentStatusForPosSale(paid),
      })
      if (paid) payment.paidAt = now
      await this.payments.savePayment(payment)
    } catch (error) {
      await this.restoreStock(decremented)
      await this.orders
        .adminPatch(order._id!, {
          status: 'cancelled',
          cancellationReason: 'No se pudo registrar el pago de la venta POS',
        }, actor.userId)
        .catch(() => null)
      throw error
    }

    if (decremented.length) {
      await Promise.all(
        decremented.map((line) =>
          this.inventory.logMovement({
            sku: line.sku,
            type: 'pos_sale',
            quantityDelta: -line.quantity,
            orderId: order._id,
            orderNumber: order.orderNumber,
            actorId: actor.userId,
            reason: 'Venta presencial',
          }),
        ),
      )
    }

    await this.recordFinancialEvents(order)
    return this.toResult(order, false)
  }

  async confirmPayment(
    id: string,
    actor: PosActor,
    details: {
      cashReceived?: number | null
      changeGiven?: number | null
      transferReference?: string | null
      note?: string
    } = {},
  ): Promise<PosSaleView> {
    const order = await this.orders.findEntityById(id)
    if (!order) throw AppError.notFound('Venta no encontrada')
    if (order.channel !== 'pos') throw AppError.badRequest('La venta no corresponde a un POS')
    if (order.status === 'cancelled') throw AppError.badRequest('La venta está cancelada y no puede confirmarse')
    if (order.paymentStatus === 'paid') throw AppError.badRequest('La venta ya está pagada')

    // G3: la confirmación liquida el saldo pendiente mediante el libro de pagos. Nunca marca
    // la venta como pagada por su cuenta: el saldo debe quedar cubierto por pagos aprobados.
    if (order.paymentMethod !== 'cash' && order.paymentMethod !== 'bank_transfer') {
      throw AppError.badRequest('Este método de pago no se puede confirmar desde el POS.')
    }
    // Importe exacto a cobrar ahora: el anticipo pendiente, o el saldo completo si el anticipo ya está pagado.
    const paid = order.paidAmount ?? 0
    const balance = order.balanceDue ?? round2(order.total - paid)
    const initialRemaining = round2(Math.max(0, (order.initialPaymentRequired ?? order.total) - paid))
    const next = nextRequiredPayment({ balanceDue: balance, initialRemaining })
    if (order.paymentMethod === 'cash') {
      const received = details.cashReceived != null ? round2(details.cashReceived) : null
      if (received === null || received < next) {
        throw AppError.badRequest('El importe recibido en efectivo no puede ser inferior al importe a cobrar')
      }
    }
    await this.orderPayments.registerPayment(
      id,
      {
        method: order.paymentMethod,
        amount: next,
        receivedAmount: details.cashReceived ?? null,
        transferReference: details.transferReference ?? order.transferReference ?? null,
        note: details.note,
      },
      { userId: actor.userId },
    )

    const updated = await this.orders.findEntityById(id)
    if (!updated) throw AppError.notFound('Venta no encontrada')
    await this.recordFinancialEvents(updated)
    return toPosSaleView(updated)
  }

  private async assertPaymentMethod(methodId: string): Promise<PosPaymentMethodView> {
    const methods = await this.getPaymentMethods()
    const method = methods.find((item) => item.methodId === methodId)
    if (!method) {
      throw AppError.badRequest(
        'El método de pago no está habilitado para ventas presenciales',
      )
    }
    return method
  }

  private async resolveCustomer(input: PosSaleDto): Promise<{
    userId: string | null
    posCustomerId: string | null
    name: string
    phone: string
    email: string | null
  }> {
    if (input.customer.mode === 'existing' && input.customer.posCustomerId) {
      const record = await this.posCustomers.findById(input.customer.posCustomerId.trim())
      if (!record) throw AppError.badRequest('El cliente de mostrador seleccionado no existe')
      return {
        userId: null,
        posCustomerId: record.id,
        name: record.name,
        phone: record.phone ?? '',
        email: record.email,
      }
    }

    if (input.customer.mode === 'existing') {
      const userId = input.customer.userId?.trim()
      if (!userId) throw AppError.badRequest('Selecciona un cliente existente')
      const user = await this.users.findByIdSafe(userId)
      if (!user) throw AppError.badRequest('El cliente seleccionado no existe')
      const address = primaryAddress(user)
      return {
        userId,
        posCustomerId: null,
        name: user.name ?? user.nickname ?? user.email,
        phone: address?.phone ?? '',
        email: user.email ?? null,
      }
    }

    const email = input.customer.email?.trim() || null
    const name = input.customer.name?.trim() || ''
    const phone = input.customer.phone?.trim() || ''
    // Sin ningún dato de contacto no hay nada que registrar: venta anónima de consumidor final.
    if (!name && !phone && !email) {
      return { userId: null, posCustomerId: null, name: CONSUMER_FINAL, phone: '', email: null }
    }
    const record = await this.posCustomers.findOrCreate({ name, phone, email }, 'pos')
    return {
      userId: null,
      posCustomerId: record.id,
      name: record.name,
      phone,
      email,
    }
  }

  private async buildLines(input: PosSaleDto): Promise<PosSaleLine[]> {
    const quantities = new Map<string, number>()
    for (const item of input.items) {
      const sku = item.sku.trim()
      if (!sku) throw AppError.badRequest('SKU vacío en la venta')
      quantities.set(sku, (quantities.get(sku) ?? 0) + item.quantity)
    }

    const promotions = await this.promotions.findActiveAt(new Date())
    const now = new Date()
    const productCache = new Map<string, Awaited<ReturnType<ProductRepository['findBySlugOrId']>>>()
    const lines: PosSaleLine[] = []

    for (const [sku, quantity] of quantities) {
      const rawVariant = await this.products.getVariantBySku(sku)
      if (!rawVariant) throw AppError.badRequest(`El producto con SKU "${sku}" no existe`)

      let product = productCache.get(rawVariant.product_slug)
      if (product === undefined) {
        product = await this.products.findBySlugOrId(rawVariant.product_slug)
        productCache.set(rawVariant.product_slug, product)
      }
      if (!product) throw AppError.badRequest(`El producto de la variante "${sku}" no existe`)

      const variant = product.variants.find((item) => item.sku === sku)
      const basePrice = round2(variant?.price ?? rawVariant.price)
      const currency = variant?.currency ?? rawVariant.currency ?? 'COP'
      const inventoryRows = variant?.inventory ?? []
      const isPerOrder = inventoryRows.some((row) => row.is_per_order)
      const promotion = resolveBestPromotionForProductFromEntities(
        product.slug,
        product.categorySlug ?? null,
        promotions,
        now,
      )
      const unitPrice = promotion
        ? round2(applyPercentToPrice(basePrice, promotion.percentOff))
        : basePrice

      lines.push({
        sku,
        quantity,
        productId: product.id,
        productSlug: product.slug,
        name: product.name,
        variantLabel: variant
          ? variantLabel(variant)
          : rawVariant.description?.trim() || sku,
        imageUrl: variant?.imagePath ?? product.imagePath ?? null,
        unitPrice,
        originalUnitPrice: basePrice,
        subtotal: round2(unitPrice * quantity),
        currency,
        promotionPercentOff: promotion?.percentOff,
        promotionId: promotion?.promotionId,
        taxRate: product.taxRate ?? null,
        tracked: inventoryRows.length > 0 && !isPerOrder,
        isPerOrder,
      })
    }

    return lines
  }

  /** All lines of a sale must share one currency; the sale is never converted automatically. */
  private assertSingleCurrency(lines: PosSaleLine[]): string {
    const currencies = new Set(lines.map((line) => line.currency))
    if (currencies.size > 1) {
      throw AppError.badRequest(
        `Los productos de una venta deben estar en la misma moneda (encontradas: ${[...currencies].join(', ')})`,
      )
    }
    return lines[0]?.currency ?? 'COP'
  }

  private async assertStock(lines: PosSaleLine[]): Promise<void> {
    for (const line of lines) {
      if (!line.tracked) continue
      const inventory = await this.inventory.getBySku(line.sku)
      if (!inventory) continue
      if (inventory.isPerOrder) continue
      if (inventory.available < line.quantity) {
        throw AppError.badRequest(
          `Sin existencias suficientes para ${line.name}${line.variantLabel ? ` (${line.variantLabel})` : ''}. Disponible: ${inventory.available}`,
        )
      }
    }
  }

  private async restoreStock(lines: PosSaleLine[]): Promise<void> {
    await Promise.all(
      lines.map(async (line) => {
        await this.inventory.incrementAtomic(line.sku, line.quantity).catch(() => undefined)
        await this.inventory
          .logMovement({
            sku: line.sku,
            type: 'pos_cancelled',
            quantityDelta: line.quantity,
            reason: 'Reversión de venta POS fallida',
          })
          .catch(() => undefined)
      }),
    )
  }

  private toResult(order: OrderEntity, replayed: boolean): PosSaleResult {
    return {
      order: toPosSaleView(order),
      receiptUrl: `/api/admin/pos/sales/${order._id}/receipt`,
      replayed,
    }
  }
}

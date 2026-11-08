import { AppError } from '../../../common/errors/app.error.js'
import type { CartRepository } from '../../sales/infrastructure/cart.repository.js'
import type { OrderRepository } from '../../sales/infrastructure/order.repository.js'
import type { InventoryRepository } from '../../catalog/infrastructure/inventory.repository.js'
import type { OrderEntity } from '../../sales/domain/order.entity.js'
import type { MercadoPagoClient, MercadoPagoStatus } from '../infrastructure/mercadopago.client.js'
import type { PaymentRepository } from '../infrastructure/payment.repository.js'
import { createPaymentEntity, createPaymentEvent, type PaymentStatus } from '../domain/payment.types.js'
import { MERCADOPAGO_DISABLED_CODE } from '../domain/mercadopago-gate.js'
import type { ManualPaymentService } from './manual-payment.service.js'

const DEFAULT_CURRENCY = 'COP'
const TERMINAL_PAYMENT_STATUSES: ReadonlySet<PaymentStatus> = new Set([
  'approved',
  'rejected',
  'cancelled',
  'refunded',
  'charged_back',
])

export interface OnlinePaymentConfig {
  /** Base del storefront para back_urls (FRONTEND_URL). */
  frontendUrl: string
  /** URL pública del webhook de Mercado Pago en este servidor. */
  notificationUrl: string
}

export interface OnlinePaymentNotifier {
  notifyPaymentApproved(userId: string, orderNumber: string): Promise<void>
}

export interface PreferenceResult {
  paymentId: string
  providerPreferenceId: string
  initPoint?: string
  sandboxInitPoint?: string
  orderId: string
  orderNumber?: string
}

export type WebhookOutcome =
  | { status: PaymentStatus; ignored: false }
  | { status: 'ignored'; ignored: true; reason: 'payment_not_found' | 'already_processed' | 'order_not_found' | 'already_paid' }
  | { status: 'amount_mismatch'; ignored: true }

/**
 * Pagos en línea con Mercado Pago. Porta a `server` el flujo de Lumia (preferencia, reintento,
 * webhook) con tres correcciones:
 *  - el webhook verifica el monto cobrado contra el total de la orden antes de marcarla pagada;
 *  - el stock se descuenta por SKU de variante con descuento atómico (Lumia usaba productId);
 *  - el external_reference conserva el formato de Lumia (`order-<id>-attempt-<n>`), así los
 *    pagos creados antes de la migración siguen siendo reconocidos por el webhook.
 */
export class OnlinePaymentService {
  constructor(
    private readonly payments: PaymentRepository,
    private readonly orders: OrderRepository,
    private readonly carts: CartRepository,
    private readonly inventory: InventoryRepository,
    private readonly manual: ManualPaymentService,
    private readonly mp: MercadoPagoClient | null,
    private readonly config: OnlinePaymentConfig,
    private readonly notifier?: OnlinePaymentNotifier,
  ) {}

  private client(): MercadoPagoClient {
    // Sin cliente = integración apagada (MERCADOPAGO_ENABLED=false): nunca se llega a la API de cobro.
    if (!this.mp) throw new AppError(503, 'Mercado Pago está desactivado en este entorno', MERCADOPAGO_DISABLED_CODE)
    return this.mp
  }

  private async loadPayableOrder(orderId: string): Promise<OrderEntity> {
    const order = await this.orders.findEntityById(orderId)
    if (!order) throw AppError.notFound('Orden no encontrada')
    if (order.status === 'paid' || order.paymentStatus === 'paid') {
      throw AppError.badRequest('La orden ya está pagada')
    }
    if (order.status === 'cancelled' || order.status === 'expired') {
      throw AppError.badRequest('La orden no está disponible para pago')
    }
    return order
  }

  async createPreference(orderId: string, options: { payerEmail?: string | null } = {}): Promise<PreferenceResult> {
    // Primero el cliente: con la integración apagada se rechaza antes de tocar la orden.
    const client = this.client()
    const order = await this.loadPayableOrder(orderId)
    const orderNumber = order.orderNumber ?? orderId

    // Solo una preferencia activa por orden: se cancelan las anteriores pendientes.
    const existing = await this.payments.listPaymentsByOrderId(orderId)
    for (const previous of existing) {
      if (previous.status !== 'pending' && previous.status !== 'created') continue
      if (previous.providerPreferenceId) await client.cancelPreference(previous.providerPreferenceId)
      await this.payments.updatePaymentStatus(previous._id!, 'cancelled', 'Cancelled by new preference')
      await this.payments.addPaymentEvent(
        previous._id!,
        createPaymentEvent('payment.cancelled', 'system', { reason: 'new_preference_created' }),
      )
    }

    const attemptNumber = existing.length + 1
    const externalReference = `order-${orderId}-attempt-${attemptNumber}`
    const preference = await client.createPreference({
      orderId,
      orderNumber,
      amount: order.total,
      currency: order.currency ?? DEFAULT_CURRENCY,
      description: `Pedido Lumia ${orderNumber}`,
      externalReference,
      payerEmail: options.payerEmail ?? order.email ?? undefined,
      backUrls: {
        success: `${this.config.frontendUrl}/thank-you/${orderNumber}`,
        failure: `${this.config.frontendUrl}/checkout`,
        pending: `${this.config.frontendUrl}/checkout`,
      },
      notificationUrl: this.config.notificationUrl,
    })

    const payment = createPaymentEntity({
      orderId,
      attemptNumber,
      externalReference,
      amount: order.total,
      currency: order.currency ?? DEFAULT_CURRENCY,
      paymentMethod: 'mercadopago',
      providerPreferenceId: preference.providerPreferenceId,
      status: 'pending',
    })
    const paymentId = await this.payments.savePayment(payment)

    return {
      paymentId,
      providerPreferenceId: preference.providerPreferenceId,
      initPoint: preference.initPoint,
      sandboxInitPoint: preference.sandboxInitPoint,
      orderId,
      orderNumber: order.orderNumber,
    }
  }

  async retry(orderId: string, method: 'mercadopago' | 'manual', cartKey?: string | null) {
    if (method === 'mercadopago') this.client()
    const order = await this.orders.findEntityById(orderId)
    if (!order) throw AppError.notFound('Orden no encontrada')
    if (method === 'manual') {
      return this.manual.createForOrder(orderId, { cartKey: cartKey ?? order.userId ?? undefined, userId: order.userId })
    }
    return this.createPreference(orderId)
  }

  /**
   * Procesa una notificación de pago. Siempre verifica el estado real en Mercado Pago;
   * nunca confía en el cuerpo de la notificación. Es idempotente: un pago ya terminal no
   * vuelve a producir efectos.
   */
  async confirmWebhook(providerPaymentId: string): Promise<WebhookOutcome> {
    const verification = await this.client().getPayment(providerPaymentId)

    const payment = verification.externalReference
      ? await this.payments.findPaymentByExternalReference(verification.externalReference)
      : null
    if (!payment) return { status: 'ignored', ignored: true, reason: 'payment_not_found' }

    if (TERMINAL_PAYMENT_STATUSES.has(payment.status)) {
      return { status: 'ignored', ignored: true, reason: 'already_processed' }
    }

    if (verification.status !== 'approved') {
      const mapped = mapProviderStatus(verification.status)
      await this.payments.updatePaymentStatus(payment._id!, mapped, verification.statusDetail)
      return { status: mapped, ignored: false }
    }

    const order = await this.orders.findEntityById(payment.orderId)
    if (!order) return { status: 'ignored', ignored: true, reason: 'order_not_found' }
    if (order.paymentStatus === 'paid' || order.status === 'paid') {
      return { status: 'ignored', ignored: true, reason: 'already_paid' }
    }

    // Verificación de monto: un cobro distinto al total no marca la orden como pagada.
    if (verification.transactionAmount !== undefined && toCents(verification.transactionAmount) !== toCents(order.total)) {
      await this.payments.addPaymentEvent(
        payment._id!,
        createPaymentEvent('payment.amount_mismatch', 'provider', {
          providerPaymentId,
          received: verification.transactionAmount,
          expected: order.total,
        }),
      )
      return { status: 'amount_mismatch', ignored: true }
    }

    const paidAt = new Date()
    await this.payments.markApprovedByProvider(payment._id!, providerPaymentId, paidAt)
    const changed = await this.orders.markOnlinePaid(order._id!, {
      paymentMethod: 'mercadopago',
      providerPaymentId,
      paidAt,
    })
    if (!changed) return { status: 'ignored', ignored: true, reason: 'already_paid' }

    // Reclamo atómico: si otro proceso ya descontó esta orden, no se vuelve a descontar.
    if (await this.orders.claimStockDecrement(order._id!)) await this.decrementStock(order)

    if (order.userId) {
      await this.carts.clear(order.userId).catch(() => undefined)
      await this.notifier
        ?.notifyPaymentApproved(order.userId, order.orderNumber ?? order._id!)
        .catch(() => undefined)
    }

    return { status: 'approved', ignored: false }
  }

  /** Descuenta por SKU de variante. Un fallo no revierte el pago: queda registrado en la orden. */
  private async decrementStock(order: OrderEntity): Promise<void> {
    const failures: string[] = []
    for (const item of order.items) {
      const sku = item.variantSku
      if (!sku) {
        failures.push(`${item.productId}: sin SKU de variante`)
        continue
      }
      const ok = await this.inventory.decrementAtomic(sku, item.quantity)
      if (!ok) failures.push(`${sku}: sin existencias suficientes`)
    }
    if (failures.length) {
      await this.orders.updatePaymentStatus(order._id!, 'paid', {
        type: 'inventory.updated',
        timestamp: new Date(),
        source: 'system',
        data: { error: 'INVENTORY_DECREMENT_FAILED', details: failures },
      })
    }
  }
}

function toCents(amount: number): number {
  return Math.round(amount * 100)
}

function mapProviderStatus(status: MercadoPagoStatus): PaymentStatus {
  return status
}

import { AppError } from '../../../common/errors/app.error.js'
import type { CartRepository } from '../../sales/infrastructure/cart.repository.js'
import type { OrderRepository } from '../../sales/infrastructure/order.repository.js'
import {
  createPaymentEntity,
  createPaymentEvent,
} from '../domain/payment.types.js'
import type { PaymentRepository } from '../infrastructure/payment.repository.js'

export interface ManualPaymentResult {
  paymentId: string
  orderId: string
  orderNumber?: string
  instructions: string
  paymentStatus: 'pending_manual'
}

export class ManualPaymentService {
  constructor(
    private readonly payments: PaymentRepository,
    private readonly orders: OrderRepository,
    private readonly carts: CartRepository,
  ) {}

  async createForOrder(
    orderId: string,
    options?: { cartKey?: string; userId?: string | null },
  ): Promise<ManualPaymentResult> {
    const order = await this.orders.findByIdSafe(orderId)
    if (!order) throw AppError.notFound('Orden no encontrada')
    if (order.status === 'paid' || order.paymentStatus === 'paid') {
      throw AppError.badRequest('La orden ya está pagada')
    }
    if (order.status === 'cancelled' || order.status === 'expired') {
      throw AppError.badRequest('La orden no admite pago')
    }

    const existingPayments = await this.payments.listPaymentsByOrderId(orderId)
    const pendingManual = existingPayments.find(
      (p) => p.paymentMethod === 'manual' && (p.status === 'pending' || p.status === 'created'),
    )
    if (pendingManual) {
      await this.clearCartForOrder(order.userId, options?.cartKey)
      return {
        paymentId: pendingManual._id!,
        orderId,
        orderNumber: order.orderNumber,
        instructions: MANUAL_INSTRUCTIONS,
        paymentStatus: 'pending_manual',
      }
    }

    const attemptNumber = existingPayments.length + 1
    const externalReference = `order-${orderId}-manual-${attemptNumber}`

    const payment = createPaymentEntity({
      orderId,
      attemptNumber,
      externalReference,
      amount: order.total,
      currency: order.currency ?? 'COP',
      paymentMethod: 'manual',
      providerPreferenceId: `manual-${orderId}-${attemptNumber}`,
      status: 'pending',
    })
    payment.events.push(createPaymentEvent('payment.manual_pending', 'system'))

    const paymentId = await this.payments.savePayment(payment)
    await this.orders.updatePaymentStatus(orderId, 'pending_manual', {
      type: 'payment.manual_pending',
      timestamp: new Date(),
      source: 'system',
      data: { paymentId, attemptNumber },
    })

    await this.clearCartForOrder(order.userId, options?.cartKey ?? order.userId ?? undefined)

    return {
      paymentId,
      orderId,
      orderNumber: order.orderNumber,
      instructions: MANUAL_INSTRUCTIONS,
      paymentStatus: 'pending_manual',
    }
  }

  private async clearCartForOrder(userId: string | null, cartKey?: string) {
    const key = userId ?? cartKey
    if (!key) return
    try {
      await this.carts.clear(key)
    } catch {
      // No crítico — el frontend también puede limpiar el carrito local
    }
  }
}

const MANUAL_INSTRUCTIONS =
  'El vendedor se comunicará contigo para coordinar el pago. El pedido quedará en espera de confirmación.'

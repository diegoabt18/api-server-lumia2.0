import { randomUUID } from 'node:crypto'
import { AppError } from '../../../common/errors/app.error.js'
import {
  createPaymentEntity,
  createPaymentEvent,
  type PaymentEntity,
} from '../../payments/domain/payment.types.js'
import type { PaymentRepository } from '../../payments/infrastructure/payment.repository.js'
import type { OrderRepository } from '../infrastructure/order.repository.js'
import type { OrderEntity, OrderEvent } from '../domain/order.entity.js'
import {
  allocatePaidAmount,
  computeOrderPaymentState,
  sumInitialRequired,
  nextRequiredPayment,
  type LedgerLine,
} from '../domain/order-payment-ledger.js'
import type { OrderStockService } from './order-stock.service.js'

/** Métodos que Server registra hoy en mostrador. Mercado Pago queda fuera mientras esté desactivado. */
export const REGISTRABLE_PAYMENT_METHODS = ['cash', 'bank_transfer'] as const
export type RegistrablePaymentMethod = (typeof REGISTRABLE_PAYMENT_METHODS)[number]

export interface RegisterOrderPaymentInput {
  method: RegistrablePaymentMethod
  amount: number
  /** Solo efectivo: importe entregado por el cliente. Debe cubrir `amount`. */
  receivedAmount?: number | null
  /** Solo transferencia: referencia bancaria. Obligatoria y única entre pagos aprobados. */
  transferReference?: string | null
  note?: string
  /**
   * Clave de idempotencia del cliente. Un reintento con la misma clave devuelve el resultado del
   * primer registro en vez de cobrar de nuevo (pérdida de conexión, doble envío).
   */
  idempotencyKey?: string | null
}

/** Caducidad del bloqueo por pedido: si un proceso se cae, el siguiente intento lo recupera. */
const LEDGER_LOCK_TTL_MS = 30_000

const idempotencyReference = (orderId: string, key: string) => `pay-${orderId}-key-${key}`

export interface PaymentActor {
  userId: string
}

const round2 = (n: number) => Math.round(n * 100) / 100

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000
}

/**
 * Registro de pagos y saldos de pedidos (G3). Todo cambio de importes pasa por aquí:
 * se registra un pago aprobado y después se recalcula el pedido desde el libro de pagos.
 */
export class OrderPaymentService {
  constructor(
    private readonly orders: OrderRepository,
    private readonly payments: PaymentRepository,
    private readonly stock: OrderStockService,
  ) {}

  /** Líneas para el reparto. Pedidos anteriores a G2 sin pago inicial por línea exigen su total. */
  private ledgerLines(order: OrderEntity): LedgerLine[] {
    return order.items.map((item, index) => {
      const lineTotal = round2(item.subtotal)
      return {
        index,
        lineTotal,
        initialPaymentRequired: round2(item.initialPaymentRequired ?? lineTotal),
      }
    })
  }

  private async loadOrder(orderId: string): Promise<OrderEntity> {
    const order = await this.orders.findEntityById(orderId)
    if (!order) throw AppError.notFound('Orden no encontrada')
    return order
  }

  /**
   * Pedidos marcados como pagados antes de G3 no tienen libro de pagos. Se bloquean para no
   * duplicar un cobro ni reabrir un pedido que ya está cerrado.
   */
  private assertLedgerAvailable(order: OrderEntity) {
    // Mongo guarda `undefined` como `null`: ambos significan "sin libro de pagos".
    if (order.paidAmount == null && order.status === 'paid') {
      throw AppError.badRequest('Pedido anterior al libro de pagos: ya está pagado y no admite nuevos cobros.')
    }
    if (order.status === 'cancelled' || order.status === 'expired') {
      throw AppError.badRequest('El pedido no admite pagos en su estado actual.')
    }
  }

  private async approvedPayments(orderId: string): Promise<{ all: PaymentEntity[]; approved: PaymentEntity[]; paid: number }> {
    const all = await this.payments.listPaymentsByOrderId(orderId)
    const approved = all.filter((p) => p.status === 'approved')
    const paid = round2(approved.reduce((sum, p) => sum + p.amount - (p.refundedAmount ?? 0), 0))
    return { all, approved, paid }
  }

  /**
   * Registra un pago con exclusión mutua por pedido: dos operadores o dos envíos simultáneos no
   * pueden consumir el mismo saldo. Quien no obtiene el bloqueo recibe 409 y debe reintentar.
   */
  async registerPayment(orderId: string, input: RegisterOrderPaymentInput, actor: PaymentActor) {
    const order = await this.loadOrder(orderId)
    this.assertLedgerAvailable(order)

    const now = new Date()
    const token = randomUUID()
    const acquired = await this.orders.acquireLedgerLock(
      orderId,
      token,
      now,
      new Date(now.getTime() - LEDGER_LOCK_TTL_MS),
    )
    if (!acquired) {
      throw AppError.conflict('Hay otro cobro en curso sobre este pedido. Espera un momento y vuelve a intentar.')
    }
    try {
      return await this.registerPaymentLocked(orderId, input, actor)
    } finally {
      await this.orders.releaseLedgerLock(orderId, token)
    }
  }

  private async registerPaymentLocked(orderId: string, input: RegisterOrderPaymentInput, actor: PaymentActor) {
    const key = input.idempotencyKey?.trim() || null
    if (key) {
      const replay = await this.payments.findPaymentByExternalReference(idempotencyReference(orderId, key))
      if (replay) return this.getSummary(orderId)
    }

    const order = await this.loadOrder(orderId)
    this.assertLedgerAvailable(order)

    const total = round2(order.total)
    const { all, paid } = await this.approvedPayments(orderId)
    const balance = round2(total - paid)
    if (balance <= 0) throw AppError.badRequest('El pedido no tiene saldo pendiente.')

    const amount = round2(input.amount)
    if (!(amount > 0)) throw AppError.badRequest('El importe debe ser mayor que cero.')

    // Importe exacto obligatorio: primero el anticipo completo, después el saldo completo.
    const initialRemaining = round2(Math.max(0, sumInitialRequired(this.ledgerLines(order)) - paid))
    const required = nextRequiredPayment({ balanceDue: balance, initialRemaining })
    if (amount !== required) {
      throw AppError.badRequest(
        initialRemaining > 0
          ? `Mientras el anticipo esté pendiente, registra exactamente su importe: ${required}.`
          : `El anticipo ya está pagado. Para confirmar el pedido registra el saldo completo: ${required}.`,
      )
    }

    let receivedAmount: number | null = null
    let changeGiven: number | null = null
    let providerPaymentId: string | undefined
    if (input.method === 'cash') {
      const received = input.receivedAmount == null ? NaN : round2(input.receivedAmount)
      if (!Number.isFinite(received) || received < amount) {
        throw AppError.badRequest('El efectivo recibido no puede ser inferior al importe cobrado.')
      }
      receivedAmount = received
      changeGiven = round2(received - amount)
    } else {
      const reference = input.transferReference?.trim()
      if (!reference) throw AppError.badRequest('La transferencia requiere la referencia bancaria.')
      const duplicate = await this.payments.findApprovedByProviderReference('bank_transfer', reference)
      if (duplicate) throw AppError.badRequest('Esa referencia de transferencia ya fue registrada.')
      providerPaymentId = reference
    }

    const now = new Date()
    const attemptNumber = all.length + 1
    const payment = createPaymentEntity({
      orderId,
      attemptNumber,
      externalReference: key ? idempotencyReference(orderId, key) : `pay-${orderId}-${attemptNumber}`,
      amount,
      currency: order.currency ?? 'COP',
      paymentMethod: input.method,
      status: 'approved',
    })
    payment.paidAt = now
    payment.providerPaymentId = providerPaymentId
    payment.receivedAmount = receivedAmount
    payment.changeGiven = changeGiven
    payment.registeredByUserId = actor.userId
    payment.events.push(
      createPaymentEvent('payment.approved', 'admin', {
        method: input.method,
        amount,
        note: input.note,
        actorId: actor.userId,
      }),
    )
    try {
      await this.payments.savePayment(payment)
    } catch (error) {
      // Carrera entre pedidos distintos: el índice único global rechaza la segunda referencia.
      if (input.method === 'bank_transfer' && isDuplicateKeyError(error)) {
        throw AppError.badRequest('Esa referencia de transferencia ya fue registrada.')
      }
      throw error
    }

    return this.recalculate(orderId, { actorId: actor.userId, method: input.method, amount })
  }

  /**
   * Recalcula pagado, saldo y reparto por línea desde los pagos aprobados. Marca el pedido como
   * pagado solo cuando el saldo llega a cero y entonces aplica el descuento de stock.
   */
  async recalculate(
    orderId: string,
    context: { actorId: string | null; method: string; amount: number },
  ) {
    const order = await this.loadOrder(orderId)
    const lines = this.ledgerLines(order)
    const total = round2(order.total)
    const { all, paid } = await this.approvedPayments(orderId)
    const state = computeOrderPaymentState({
      total,
      initialPaymentRequired: sumInitialRequired(lines),
      paidAmount: paid,
    })
    const allocations = allocatePaidAmount(lines, state.paidAmount)
    const now = new Date()

    const event: OrderEvent = {
      type: state.isFullyPaid ? 'payment.balance_settled' : 'payment.recorded',
      timestamp: now,
      source: 'admin',
      actorId: context.actorId ?? undefined,
      data: {
        method: context.method,
        amount: context.amount,
        paidAmount: state.paidAmount,
        balanceDue: state.balanceDue,
        paymentStatus: state.paymentStatus,
      },
    }

    const updated = await this.orders.applyPaymentLedger(orderId, {
      lines: allocations.map((a) => ({ index: a.index, paidAmount: a.paidAmount, balanceDue: a.balanceDue })),
      paidAmount: state.paidAmount,
      balanceDue: state.balanceDue,
      paymentStatus: state.paymentStatus,
      markPaid: state.isFullyPaid
        ? { actorId: context.actorId, paidAt: now, paymentMethod: context.method }
        : undefined,
      event,
    })
    if (!updated) throw AppError.notFound('Orden no encontrada')

    if (state.isFullyPaid) {
      // El descuento de stock va primero: no puede depender de tareas auxiliares.
      await this.stock.applyOnPaid(updated)
      // Cerrar las expectativas de pago pendientes. Un fallo aquí no revierte el pago ya registrado.
      for (const pending of all) {
        if (pending.status !== 'pending' || !pending._id) continue
        try {
          await this.payments.updatePaymentStatus(pending._id, 'cancelled', 'Saldo cubierto por pagos registrados')
        } catch {
          // Se conserva el pago aprobado; la expectativa pendiente queda visible para revisión.
        }
      }
    }

    return this.summaryFromState(updated, allocations, state, all)
  }

  async getSummary(orderId: string) {
    const order = await this.loadOrder(orderId)
    const lines = this.ledgerLines(order)
    const { all, paid } = await this.approvedPayments(orderId)
    const state = computeOrderPaymentState({
      total: round2(order.total),
      initialPaymentRequired: sumInitialRequired(lines),
      paidAmount: paid,
    })
    return this.summaryFromState(order, allocatePaidAmount(lines, state.paidAmount), state, all, paid)
  }

  private summaryFromState(
    order: OrderEntity,
    allocations: ReturnType<typeof allocatePaidAmount>,
    state: ReturnType<typeof computeOrderPaymentState>,
    payments: PaymentEntity[],
    approvedPaid = state.paidAmount,
  ) {
    const initialRequired = sumInitialRequired(this.ledgerLines(order))
    const initialRemaining = round2(Math.max(0, initialRequired - approvedPaid))
    const lines = order.items.map((item, index) => {
      const alloc = allocations[index]!
      return {
        index,
        name: item.name,
        variantSku: item.variantSku ?? null,
        fulfillmentMode: item.fulfillmentMode ?? 'stock',
        lineTotal: round2(item.subtotal),
        initialPaymentRequired: round2(item.initialPaymentRequired ?? item.subtotal),
        paidAmount: alloc.paidAmount,
        balanceDue: alloc.balanceDue,
      }
    })
    return {
      orderId: order._id,
      total: round2(order.total),
      initialPaymentRequired: initialRequired,
      initialRemaining,
      /** Importe exacto que se debe registrar a continuación (anticipo pendiente, luego saldo). */
      nextPaymentRequired: nextRequiredPayment({ balanceDue: state.balanceDue, initialRemaining }),
      paidAmount: state.paidAmount,
      balanceDue: state.balanceDue,
      paymentStatus: state.paymentStatus,
      status: order.status,
      lines,
      payments: payments.map((p) => ({
        id: p._id,
        method: p.paymentMethod,
        amount: p.amount,
        status: p.status,
        paidAt: p.paidAt ?? null,
        reference: p.providerPaymentId ?? null,
        receivedAmount: p.receivedAmount ?? null,
        changeGiven: p.changeGiven ?? null,
      })),
    }
  }
}

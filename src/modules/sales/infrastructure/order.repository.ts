import { randomUUID } from 'node:crypto'

/**
 * Referencia corta para el cliente: mismo prefijo y sufijo aleatorio del número interno.
 * ORD-20261108-185352-CB07203E → ORD-CB07203E. Identifica el pedido; no es una credencial.
 */
export function customerReferenceOf(orderNumber: string): string {
  const parts = orderNumber.split('-')
  return `${parts[0]}-${parts[parts.length - 1]}`
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
import { ObjectId, type Db } from 'mongodb'
import { BaseRepository, getCollection } from '../../../database/repositories/base.repository.js'
import { toOrderDomain, type OrderDomain, type OrderEntity, type OrderEvent, type CancelledBy } from '../domain/order.entity.js'
import { getEnv } from '../../../config/env.js'

interface OrderDocument extends Omit<OrderEntity, '_id'> {
  _id: ObjectId
}

function toEntity(doc: OrderDocument): OrderEntity {
  return { ...doc, _id: doc._id.toString() }
}

export class OrderRepository extends BaseRepository<OrderDocument> {
  private readonly db: Db

  /** Pedidos pagados y aún sin despachar desde antes de `before` (para iniciativas de Lumi). Solo datos mínimos. */
  async findPaidBefore(before: Date, limit: number): Promise<Array<{ id: string; orderNumber: string | null; createdAt: Date }>> {
    const docs = await this.collection
      .find({ status: 'paid', createdAt: { $lt: before } } as never, {
        projection: { orderNumber: 1, createdAt: 1 },
        sort: { createdAt: 1 },
        limit,
      })
      .toArray()
    return docs.map((doc) => {
      const row = doc as unknown as { _id: { toString(): string }; orderNumber?: string; createdAt: Date }
      return { id: row._id.toString(), orderNumber: row.orderNumber ?? null, createdAt: row.createdAt }
    })
  }

  constructor(db: Db) {
    super(getCollection(db, 'orders'))
    this.db = db
  }

  async ensureIndexes(): Promise<void> {
    await super.ensureIndexes([
      { key: { orderNumber: 1 }, unique: true, sparse: true },
      // Referencia corta para el cliente (ORD-XXXXXXXX). Sparse: los pedidos anteriores no la tienen.
      { key: { customerReference: 1 }, unique: true, sparse: true, name: 'uniq_customer_reference' },
      { key: { userId: 1, createdAt: -1 } },
      { key: { status: 1 } },
      { key: { createdAt: -1 } },
      { key: { channel: 1, createdAt: -1 } },
      {
        key: { idempotencyKey: 1 },
        unique: true,
        partialFilterExpression: { idempotencyKey: { $type: 'string' } },
      },
      {
        key: { receiptNumber: 1 },
        unique: true,
        partialFilterExpression: { receiptNumber: { $type: 'string' } },
      },
    ])
  }

  /**
   * Número de pedido no secuencial: prefijo, fecha y hora (zona Bogotá) y 8 caracteres aleatorios.
   * La unicidad la garantiza el índice único de `orderNumber`; createOrder reintenta si colisiona.
   */
  async generateOrderNumber(): Promise<string> {
    const env = getEnv()
    const prefix = env.ORDER_NUMBER_PREFIX
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Bogota',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date())
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00'
    const date = `${get('year')}${get('month')}${get('day')}`
    const time = `${get('hour')}${get('minute')}${get('second')}`
    const random = randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()
    return `${prefix}-${date}-${time}-${random}`
  }

  /**
   * Consecutivo atómico para ventas presenciales. Usa una colección de contadores
   * para evitar colisiones del `count()` bajo concurrencia.
   */
  async generatePosOrderNumber(): Promise<string> {
    const env = getEnv()
    const year = new Date().getFullYear()
    const counters = getCollection<{ _id: string; seq: number }>(this.db, 'counters')
    const counter = await counters.findOneAndUpdate(
      { _id: `pos_order_${year}` } as never,
      { $inc: { seq: 1 } } as never,
      { upsert: true, returnDocument: 'after' },
    )
    const seq = counter?.seq ?? 1
    return `${env.ORDER_NUMBER_PREFIX}-POS-${year}-${String(seq).padStart(6, '0')}`
  }

  async createOrder(data: Omit<OrderEntity, '_id' | 'createdAt' | 'orderNumber'>): Promise<OrderDomain> {
    const now = new Date()
    let id: string | undefined
    for (let attempt = 1; attempt <= 3 && !id; attempt++) {
      const orderNumber = await this.generateOrderNumber()
      const customerReference = customerReferenceOf(orderNumber)
      try {
        id = await this.insertOne({
          ...data,
          orderNumber,
          customerReference,
          createdAt: now,
          updatedAt: now,
        } as OrderDocument)
      } catch (error) {
        // Colisión improbable del número aleatorio: se genera otro.
        if (!(typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000) || attempt === 3) {
          throw error
        }
      }
    }
    if (!id) throw new Error('No se pudo asignar un número de pedido único')
    const created = await this.findById(id)
    if (!created) throw new Error('Failed to create order')
    return toOrderDomain(toEntity(created))
  }

  async findByIdSafe(id: string): Promise<OrderDomain | null> {
    const doc = await this.findById(id)
    return doc ? toOrderDomain(toEntity(doc)) : null
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<OrderEntity | null> {
    const doc = await this.findOne({ idempotencyKey } as never)
    return doc ? toEntity(doc) : null
  }

  async createPosOrder(
    data: Omit<OrderEntity, '_id' | 'createdAt' | 'orderNumber' | 'receiptNumber'>,
    receiptNumber: string,
  ): Promise<OrderEntity> {
    const now = new Date()
    const id = await this.insertOne({
      ...data,
      orderNumber: receiptNumber,
      receiptNumber,
      createdAt: now,
      updatedAt: now,
    } as OrderDocument)
    const created = await this.findById(id)
    if (!created) throw new Error('Failed to create POS order')
    return toEntity(created)
  }

  /** Busca por número interno o por referencia corta del cliente (sin distinguir mayúsculas). */
  async findByOrderNumber(orderNumber: string): Promise<OrderDomain | null> {
    const code = orderNumber.trim().toUpperCase()
    const doc = await this.findOne({ $or: [{ orderNumber: code }, { customerReference: code }] } as never)
    return doc ? toOrderDomain(toEntity(doc)) : null
  }

  async findByUser(userId: string, orderId: string): Promise<OrderDomain | null> {
    if (!ObjectId.isValid(orderId)) return null
    const doc = await this.findOne({
      _id: new ObjectId(orderId),
      userId,
    } as never)
    return doc ? toOrderDomain(toEntity(doc)) : null
  }

  async listByUser(userId: string, limit = 50): Promise<OrderDomain[]> {
    const docs = await this.findMany({ userId } as never, {
      limit,
      sort: { createdAt: -1 },
    })
    return docs.map((d) => toOrderDomain(toEntity(d)))
  }

  async cancelOrder(
    id: string,
    input: { cancellationReason: string; cancelledBy: CancelledBy },
  ): Promise<void> {
    if (!ObjectId.isValid(id)) throw new Error('INVALID_ORDER_ID')
    const now = new Date()
    const event: OrderEvent = {
      type: 'order.cancelled',
      timestamp: now,
      source: input.cancelledBy === 'admin' ? 'admin' : input.cancelledBy === 'customer' ? 'user' : 'system',
      data: { cancelledBy: input.cancelledBy, reason: input.cancellationReason },
    }
    await this.collection.updateOne(
      { _id: new ObjectId(id) } as never,
      {
        $set: {
          status: 'cancelled',
          paymentStatus: 'failed',
          cancelledAt: now,
          cancelledBy: input.cancelledBy,
          cancellationReason: input.cancellationReason,
          updatedAt: now,
        },
        $push: { events: event },
      },
    )
  }

  async requestCancellation(id: string, reason: string): Promise<void> {
    if (!ObjectId.isValid(id)) throw new Error('INVALID_ORDER_ID')
    const now = new Date()
    const event: OrderEvent = {
      type: 'order.cancellation_requested',
      timestamp: now,
      source: 'user',
      data: { reason },
    }
    await this.collection.updateOne(
      { _id: new ObjectId(id) } as never,
      {
        $set: {
          cancellationRequested: true,
          cancellationRequestedAt: now,
          cancellationRequestReason: reason,
          cancellationRequestStatus: 'requested',
          updatedAt: now,
        },
        $push: { events: event },
      },
    )
  }

  async updatePaymentStatus(
    id: string,
    paymentStatus: OrderEntity['paymentStatus'],
    event?: OrderEvent,
  ): Promise<void> {
    if (!ObjectId.isValid(id)) throw new Error('INVALID_ORDER_ID')
    const update: Record<string, unknown> = {
      paymentStatus,
      updatedAt: new Date(),
    }
    const ops: Record<string, unknown> = { $set: update }
    if (event) ops.$push = { events: event }
    await this.collection.updateOne({ _id: new ObjectId(id) } as never, ops)
  }

  async expireUnpaidOrders(cutoff: Date): Promise<number> {
    const result = await this.collection.updateMany(
      {
        status: 'pending',
        channel: { $ne: 'pos' },
        paymentStatus: { $in: ['unpaid', 'pending', 'pending_manual', 'in_process'] },
        createdAt: { $lt: cutoff },
      } as never,
      {
        $set: { status: 'expired', paymentStatus: 'expired', updatedAt: new Date() },
        $push: {
          events: {
            type: 'order.expired',
            timestamp: new Date(),
            source: 'system',
            data: { cutoff: cutoff.toISOString() },
          },
        },
      },
    )
    return result.modifiedCount
  }

  /**
   * Filtro de búsqueda administrativa. Ejecutado en la base de datos:
   *  - referencia corta completa (ORD-XXXXXXXX) o solo el sufijo (XXXXXXXX): coincidencia exacta, indexada;
   *  - prefijo del número interno o de la referencia: rango indexado;
   *  - nombre, correo y teléfono: solo por prefijo, para poder usar índices.
   * El término se escapa: nunca se interpreta como expresión regular.
   */
  private buildAdminSearchFilter(search?: string, channel?: string): Record<string, unknown> {
    const clauses: Record<string, unknown>[] = []
    if (search?.trim()) {
      const term = search.trim()
      const upper = term.toUpperCase()
      const escaped = escapeRegex(term)
      const or: Record<string, unknown>[] = []
      if (/^ORD-[0-9A-F]{8}$/i.test(term)) or.push({ customerReference: upper })
      else if (/^[0-9A-F]{8}$/i.test(term)) or.push({ customerReference: `ORD-${upper}` })
      or.push({ customerReference: { $regex: `^${escaped}`, $options: 'i' } })
      or.push({ orderNumber: { $regex: `^${escaped}`, $options: 'i' } })
      // Nombre, correo y teléfono: solo por prefijo (pueden usar índices). Sin coincidencias por fragmento interno.
      or.push({ customerName: { $regex: `^${escaped}`, $options: 'i' } })
      or.push({ email: { $regex: `^${escaped}`, $options: 'i' } })
      or.push({ phone: { $regex: `^${escaped}`, $options: 'i' } })
      clauses.push({ $or: or })
    }
    if (channel === 'pos') {
      clauses.push({ channel: 'pos' })
    } else if (channel === 'online') {
      clauses.push({ $or: [{ channel: 'online' }, { channel: { $exists: false } }] })
    }
    if (!clauses.length) return {}
    return clauses.length === 1 ? clauses[0]! : { $and: clauses }
  }

  async listAllAdmin(
    skip: number,
    limit: number,
    search?: string,
    channel?: string,
  ): Promise<OrderEntity[]> {
    const filter = this.buildAdminSearchFilter(search, channel)
    const docs = await this.findMany(filter as never, { skip, limit, sort: { createdAt: -1 } })
    return docs.map((d) => toEntity(d))
  }

  async countAllAdmin(search?: string, channel?: string): Promise<number> {
    return this.count(this.buildAdminSearchFilter(search, channel) as never)
  }

  async sumPaidTotal(): Promise<number> {
    const rows = await this.collection
      .aggregate([
        { $match: { status: { $in: ['paid', 'shipped', 'delivered'] } } },
        { $group: { _id: null, total: { $sum: '$total' } } },
      ])
      .toArray()
    return typeof rows[0]?.total === 'number' ? rows[0].total : 0
  }

  async findEntityById(id: string): Promise<OrderEntity | null> {
    const doc = await this.findById(id)
    return doc ? toEntity(doc) : null
  }

  async adminPatch(
    id: string,
    patch: {
      status?: OrderEntity['status']
      paymentStatus?: OrderEntity['paymentStatus']
      notes?: string
      cancellationReason?: string
    },
    actorId: string,
  ): Promise<OrderEntity | null> {
    if (!ObjectId.isValid(id)) return null
    const order = await this.findEntityById(id)
    if (!order) return null

    const now = new Date()
    const set: Record<string, unknown> = { updatedAt: now }
    const events: OrderEvent[] = []

    if (patch.status) {
      set.status = patch.status
      if (patch.status === 'delivered') set.deliveredAt = now
      if (patch.status === 'cancelled') {
        set.cancelledAt = now
        set.cancelledBy = 'admin'
        set.cancellationReason = patch.cancellationReason ?? 'Cancelado por administrador'
        events.push({
          type: 'order.cancelled',
          timestamp: now,
          source: 'admin',
          actorId,
          data: { reason: set.cancellationReason, previousStatus: order.status },
        })
      } else if (patch.status === 'paid') {
        set.paidAt = now
        events.push({ type: 'payment.manual_confirmed', timestamp: now, source: 'admin', actorId, data: {} })
      } else {
        events.push({
          type: patch.status === 'shipped' ? 'order.shipped' : patch.status === 'delivered' ? 'order.delivered' : 'order.updated',
          timestamp: now,
          source: 'admin',
          actorId,
          data: { previousStatus: order.status },
        })
      }
    }

    if (patch.paymentStatus) {
      set.paymentStatus = patch.paymentStatus
      if (patch.paymentStatus === 'paid') set.paidAt = now
      events.push({
        type: patch.paymentStatus === 'paid' ? 'payment.manual_confirmed' : 'payment.updated',
        timestamp: now,
        source: 'admin',
        actorId,
        data: { previousPaymentStatus: order.paymentStatus },
      })
    }

    if (patch.notes !== undefined) set.notes = patch.notes

    const ops: Record<string, unknown> = { $set: set }
    if (events.length) ops.$push = { events: { $each: events } }
    await this.collection.updateOne({ _id: new ObjectId(id) } as never, ops)
    return this.findEntityById(id)
  }

  async confirmPosPayment(
    id: string,
    details: {
      actorId: string
      cashReceived?: number | null
      changeGiven?: number | null
      transferReference?: string | null
    },
  ): Promise<OrderEntity | null> {
    if (!ObjectId.isValid(id)) return null
    const order = await this.findEntityById(id)
    if (!order) return null
    const now = new Date()
    const set: Record<string, unknown> = {
      status: 'paid',
      paymentStatus: 'paid',
      paidAt: now,
      paymentConfirmedByUserId: details.actorId,
      paymentConfirmedAt: now,
      updatedAt: now,
    }
    if (details.cashReceived !== undefined) set.cashReceived = details.cashReceived
    if (details.changeGiven !== undefined) set.changeGiven = details.changeGiven
    if (details.transferReference !== undefined) set.transferReference = details.transferReference

    const event: OrderEvent = {
      type: 'payment.manual_confirmed',
      timestamp: now,
      source: 'admin',
      actorId: details.actorId,
      data: {
        paymentMethod: order.paymentMethod,
        total: order.total,
        cashReceived: details.cashReceived ?? null,
        changeGiven: details.changeGiven ?? null,
        transferReference: details.transferReference ?? null,
      },
    }

    await this.collection.updateOne(
      { _id: new ObjectId(id) } as never,
      { $set: set, $push: { events: event } },
    )
    return this.findEntityById(id)
  }

  async resolveCancellationRequest(
    id: string,
    resolution: 'approved' | 'rejected' | 'info_needed',
    actorId: string,
    adminNote?: string,
  ): Promise<OrderEntity | null> {
    if (!ObjectId.isValid(id)) return null
    const now = new Date()
    const set: Record<string, unknown> = {
      cancellationRequestStatus: resolution,
      cancellationResolvedAt: now,
      updatedAt: now,
    }
    if (adminNote) set.cancellationAdminNote = adminNote

    const event: OrderEvent = {
      type: resolution === 'approved' ? 'cancellation.approved' : resolution === 'rejected' ? 'cancellation.rejected' : 'cancellation.info_requested',
      timestamp: now,
      source: 'admin',
      actorId,
      data: { resolution, adminNote },
    }

    if (resolution === 'approved') {
      set.status = 'cancelled'
      set.cancelledAt = now
      set.cancelledBy = 'admin'
      set.cancellationReason = adminNote ?? 'Cancelación aprobada por administrador'
    }

    await this.collection.updateOne(
      { _id: new ObjectId(id) } as never,
      { $set: set, $push: { events: event } },
    )
    return this.findEntityById(id)
  }

  async configureDeposit(id: string, percentage: number, actorId: string): Promise<OrderEntity | null> {
    if (!ObjectId.isValid(id)) return null
    const order = await this.findEntityById(id)
    if (!order) return null

    const depositAmount = Math.round(order.total * (percentage / 100) * 100) / 100
    const finalPaymentAmount = Math.round((order.total - depositAmount) * 100) / 100
    const now = new Date()
    const event: OrderEvent = {
      type: 'deposit.created',
      timestamp: now,
      source: 'admin',
      actorId,
      data: { percentage, depositAmount, finalPaymentAmount, total: order.total },
    }

    await this.collection.updateOne(
      { _id: new ObjectId(id) } as never,
      {
        $set: {
          depositPercentage: percentage,
          depositAmount,
          finalPaymentAmount,
          paymentStatus: 'deposit_pending',
          updatedAt: now,
        },
        $push: { events: event },
      },
    )
    return this.findEntityById(id)
  }

  async markDepositPaid(id: string, amount: number, actorId: string, note?: string): Promise<OrderEntity | null> {
    if (!ObjectId.isValid(id)) return null
    const now = new Date()
    const event: OrderEvent = {
      type: 'deposit.paid',
      timestamp: now,
      source: 'admin',
      actorId,
      data: { amount, note },
    }
    await this.collection.updateOne(
      { _id: new ObjectId(id) } as never,
      {
        $set: {
          depositPaidAt: now,
          paymentStatus: 'final_payment_pending',
          updatedAt: now,
        },
        $push: { events: event },
      },
    )
    return this.findEntityById(id)
  }

  async markFinalPaymentPaid(id: string, amount: number, actorId: string, note?: string): Promise<OrderEntity | null> {
    if (!ObjectId.isValid(id)) return null
    const now = new Date()
    const event: OrderEvent = {
      type: 'final_payment.paid',
      timestamp: now,
      source: 'admin',
      actorId,
      data: { amount, note },
    }
    await this.collection.updateOne(
      { _id: new ObjectId(id) } as never,
      {
        $set: {
          finalPaymentPaidAt: now,
          paymentStatus: 'payment_completed',
          status: 'paid',
          paidAt: now,
          updatedAt: now,
        },
        $push: { events: event },
      },
    )
    return this.findEntityById(id)
  }

  /**
   * Bloqueo por pedido para registrar pagos. Es atómico (un solo documento) y caduca si el
   * proceso que lo tomó se cae: `staleBefore` marca el límite a partir del cual se considera abandonado.
   */
  async acquireLedgerLock(id: string, token: string, now: Date, staleBefore: Date): Promise<boolean> {
    if (!ObjectId.isValid(id)) return false
    const res = await this.collection.updateOne(
      {
        _id: new ObjectId(id),
        $or: [{ ledgerLock: { $exists: false } }, { ledgerLock: null }, { 'ledgerLock.at': { $lt: staleBefore } }],
      } as never,
      { $set: { ledgerLock: { token, at: now } } } as never,
    )
    return res.modifiedCount > 0
  }

  async releaseLedgerLock(id: string, token: string): Promise<void> {
    if (!ObjectId.isValid(id)) return
    await this.collection.updateOne(
      { _id: new ObjectId(id), 'ledgerLock.token': token } as never,
      { $unset: { ledgerLock: '' } } as never,
    )
  }

  /**
   * Guarda el estado de pago recalculado desde el libro de pagos: importes por línea y del pedido.
   * Nunca se llama con importes del cliente; los produce OrderPaymentService a partir de pagos aprobados.
   */
  async applyPaymentLedger(
    id: string,
    data: {
      lines: Array<{ index: number; paidAmount: number; balanceDue: number }>
      paidAmount: number
      balanceDue: number
      paymentStatus: string
      markPaid?: { actorId: string | null; paidAt: Date; paymentMethod: string }
      event: OrderEvent
    },
  ): Promise<OrderEntity | null> {
    if (!ObjectId.isValid(id)) return null
    const now = new Date()
    const set: Record<string, unknown> = {
      paidAmount: data.paidAmount,
      balanceDue: data.balanceDue,
      paymentStatus: data.paymentStatus,
      updatedAt: now,
    }
    for (const line of data.lines) {
      set[`items.${line.index}.paidAmount`] = line.paidAmount
      set[`items.${line.index}.balanceDue`] = line.balanceDue
    }
    if (data.markPaid) {
      set.status = 'paid'
      set.paidAt = data.markPaid.paidAt
      set.paymentMethod = data.markPaid.paymentMethod
      set.paymentConfirmedAt = data.markPaid.paidAt
      set.paymentConfirmedByUserId = data.markPaid.actorId
    }
    await this.collection.updateOne(
      { _id: new ObjectId(id) } as never,
      { $set: set, $push: { events: data.event } } as never,
    )
    return this.findEntityById(id)
  }

  async findManyInRange(from: Date, to: Date): Promise<OrderEntity[]> {
    const docs = await this.findMany({ createdAt: { $gte: from, $lt: to } } as never, { sort: { createdAt: -1 } })
    return docs.map((d) => toEntity(d))
  }

  async countByUser(userId: string): Promise<number> {
    return this.count({ userId } as never)
  }

  async sumPaidTotalByUser(userId: string): Promise<number> {
    const rows = await this.collection
      .aggregate([
        { $match: { userId, status: 'paid' } },
        { $group: { _id: null, total: { $sum: '$total' } } },
      ])
      .toArray()
    return rows.length > 0 ? Number((rows[0] as { total: number }).total) : 0
  }


  /**
   * Marca una orden en línea como pagada con Mercado Pago. Idempotente: si ya está pagada no
   * hace nada y devuelve false, así un webhook duplicado no repite efectos.
   */
  async markOnlinePaid(
    orderId: string,
    data: { paymentMethod: string; providerPaymentId: string; paidAt: Date; actorId?: string },
  ): Promise<boolean> {
    if (!ObjectId.isValid(orderId)) return false
    const now = new Date()
    const result = await this.collection.updateOne(
      { _id: new ObjectId(orderId), status: { $ne: 'paid' } } as never,
      {
        $set: {
          status: 'paid',
          paymentStatus: 'paid',
          paidAt: data.paidAt,
          paymentMethod: data.paymentMethod,
          mpPaymentId: data.providerPaymentId,
          updatedAt: now,
        },
        $push: {
          events: {
            type: 'payment.approved',
            timestamp: now,
            source: 'provider',
            data: { paymentMethod: data.paymentMethod, providerPaymentId: data.providerPaymentId },
          },
        },
      } as never,
    )
    return result.modifiedCount > 0
  }
  /**
   * Reclama el descuento de stock de una orden. Es atómico: solo una llamada concurrente obtiene
   * `true`, así una orden nunca descuenta stock dos veces.
   */
  async claimStockDecrement(id: string): Promise<boolean> {
    if (!ObjectId.isValid(id)) return false
    const now = new Date()
    const res = await this.collection.updateOne(
      { _id: new ObjectId(id), stockDecrementedAt: null } as never,
      { $set: { stockDecrementedAt: now, updatedAt: now } } as never,
    )
    return res.modifiedCount > 0
  }

  /** Registra líneas que no se pudieron descontar, para revisión del administrador. */
  async recordInventoryFailure(id: string, details: string[]): Promise<void> {
    if (!ObjectId.isValid(id) || !details.length) return
    const now = new Date()
    await this.collection.updateOne(
      { _id: new ObjectId(id) } as never,
      {
        $push: {
          events: {
            type: 'inventory.updated',
            timestamp: now,
            source: 'system',
            data: { error: 'INVENTORY_DECREMENT_FAILED', details },
          },
        },
      } as never,
    )
  }

  /** Marca que el stock de la orden fue devuelto. Idempotente por la condición del filtro. */
  async markStockRestored(id: string): Promise<boolean> {
    if (!ObjectId.isValid(id)) return false
    const now = new Date()
    const res = await this.collection.updateOne(
      { _id: new ObjectId(id), stockDecrementedAt: { $ne: null }, stockRestoredAt: null } as never,
      { $set: { stockRestoredAt: now, updatedAt: now } } as never,
    )
    return res.modifiedCount > 0
  }

}

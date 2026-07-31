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
  constructor(db: Db) {
    super(getCollection(db, 'orders'))
  }

  async ensureIndexes(): Promise<void> {
    await super.ensureIndexes([
      { key: { orderNumber: 1 }, unique: true, sparse: true },
      { key: { userId: 1, createdAt: -1 } },
      { key: { status: 1 } },
      { key: { createdAt: -1 } },
    ])
  }

  async generateOrderNumber(): Promise<string> {
    const env = getEnv()
    const prefix = env.ORDER_NUMBER_PREFIX
    const year = new Date().getFullYear()
    const count = await this.count({})
    const seq = String(count + 1).padStart(6, '0')
    return `${prefix}-${year}-${seq}`
  }

  async createOrder(data: Omit<OrderEntity, '_id' | 'createdAt' | 'orderNumber'>): Promise<OrderDomain> {
    const now = new Date()
    const orderNumber = await this.generateOrderNumber()
    const id = await this.insertOne({
      ...data,
      orderNumber,
      createdAt: now,
      updatedAt: now,
    } as OrderDocument)
    const created = await this.findById(id)
    if (!created) throw new Error('Failed to create order')
    return toOrderDomain(toEntity(created))
  }

  async findByIdSafe(id: string): Promise<OrderDomain | null> {
    const doc = await this.findById(id)
    return doc ? toOrderDomain(toEntity(doc)) : null
  }

  async findByOrderNumber(orderNumber: string): Promise<OrderDomain | null> {
    const doc = await this.findOne({ orderNumber } as never)
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

  private buildAdminSearchFilter(search?: string): Record<string, unknown> {
    if (!search?.trim()) return {}
    const term = search.trim()
    return {
      $or: [
        { orderNumber: { $regex: term, $options: 'i' } },
        { customerName: { $regex: term, $options: 'i' } },
        { email: { $regex: term, $options: 'i' } },
        { phone: { $regex: term, $options: 'i' } },
      ],
    }
  }

  async listAllAdmin(skip: number, limit: number, search?: string): Promise<OrderEntity[]> {
    const filter = this.buildAdminSearchFilter(search)
    const docs = await this.findMany(filter as never, { skip, limit, sort: { createdAt: -1 } })
    return docs.map((d) => toEntity(d))
  }

  async countAllAdmin(search?: string): Promise<number> {
    return this.count(this.buildAdminSearchFilter(search) as never)
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
}

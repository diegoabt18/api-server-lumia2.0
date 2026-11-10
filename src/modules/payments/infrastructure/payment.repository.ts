import { ObjectId, type Db } from 'mongodb'
import { BaseRepository, getCollection } from '../../../database/repositories/base.repository.js'
import type { PaymentEntity, PaymentEvent, PaymentStatus } from '../domain/payment.types.js'

interface PaymentDocument extends Omit<PaymentEntity, '_id'> {
  _id: ObjectId
}

function toEntity(doc: PaymentDocument): PaymentEntity {
  return { ...doc, _id: doc._id.toString() }
}

export class PaymentRepository extends BaseRepository<PaymentDocument> {
  constructor(db: Db) {
    super(getCollection(db, 'payments'))
  }

  async ensureIndexes(): Promise<void> {
    await super.ensureIndexes([
      { key: { orderId: 1, attemptNumber: 1 } },
      { key: { externalReference: 1 }, unique: true, sparse: true },
      { key: { providerPaymentId: 1 }, sparse: true },
      { key: { status: 1, createdAt: 1 } },
      // Una referencia de transferencia aprobada solo puede existir una vez en todo el sistema,
      // independientemente del pedido: es la protección global contra abonos duplicados.
      {
        key: { paymentMethod: 1, providerPaymentId: 1 },
        unique: true,
        // Solo transferencias aprobadas con referencia real (los pagos en efectivo no la tienen: son null).
        partialFilterExpression: {
          status: 'approved',
          paymentMethod: 'bank_transfer',
          providerPaymentId: { $type: 'string' },
        },
        name: 'uniq_approved_provider_reference',
      },
    ])
  }

  async savePayment(payment: PaymentEntity): Promise<string> {
    const { _id, ...doc } = payment
    void _id
    const id = await this.insertOne(doc as PaymentDocument)
    return id
  }

  async listPaymentsByOrderId(orderId: string): Promise<PaymentEntity[]> {
    const docs = await this.findMany({ orderId } as never, { sort: { attemptNumber: 1 } })
    return docs.map((d) => toEntity(d))
  }

  async findPaymentByExternalReference(externalReference: string): Promise<PaymentEntity | null> {
    const doc = await this.findOne({ externalReference } as never)
    return doc ? toEntity(doc) : null
  }

  /** Pago aprobado con la misma referencia de transferencia (evita registrar dos veces el mismo abono). */
  async findApprovedByProviderReference(paymentMethod: string, providerPaymentId: string): Promise<PaymentEntity | null> {
    const doc = await this.findOne({ paymentMethod, providerPaymentId, status: 'approved' } as never)
    return doc ? toEntity(doc) : null
  }

  async updatePaymentStatus(
    id: string,
    status: PaymentStatus,
    detail?: string,
  ): Promise<void> {
    const set: Record<string, unknown> = { status, updatedAt: new Date() }
    if (detail !== undefined) set.statusDetail = detail
    await this.updateById(id, { $set: set })
  }

  async addPaymentEvent(id: string, event: PaymentEvent): Promise<void> {
    if (!ObjectId.isValid(id)) return
    await this.collection.updateOne(
      { _id: new ObjectId(id) } as never,
      { $push: { events: event } },
    )
  }

  async findExpiredPendingPayments(olderThan: Date): Promise<PaymentEntity[]> {
    const docs = await this.findMany(
      {
        status: { $in: ['created', 'pending', 'in_process'] },
        createdAt: { $lt: olderThan },
      } as never,
      { sort: { createdAt: 1 } },
    )
    return docs.map((d) => toEntity(d))
  }


  /** Marca un pago como aprobado por el proveedor (idempotente por estado terminal). */
  async markApprovedByProvider(id: string, providerPaymentId: string, paidAt: Date): Promise<void> {
    await this.collection.updateOne(
      { _id: new ObjectId(id), status: { $nin: ['approved', 'rejected', 'cancelled', 'refunded', 'charged_back'] } } as never,
      { $set: { status: 'approved', providerPaymentId, paidAt, updatedAt: new Date() } },
    )
  }
}

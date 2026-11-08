import type { Db } from 'mongodb'
import { MongoServerError } from 'mongodb'
import { getCollection } from '../../../database/repositories/base.repository.js'
import type { FinancialEventEntity } from '../domain/financial-event.entity.js'

const COLLECTION = 'financial_outbox'
const DEFAULT_LEASE_MS = 5 * 60 * 1000

function isDuplicateKey(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === 11000
}

/**
 * Bandeja de salida de eventos financieros (sales_db.financial_outbox).
 * - enqueue es idempotente: encolar el mismo eventKey dos veces no duplica el evento.
 * - claimPending toma lotes con arrendamiento (lockedUntil) para que dos consumidores
 *   no procesen el mismo evento; si un consumidor cae, el arrendamiento expira y se reintenta.
 */
export class FinancialOutboxRepository {
  private collection() {
    return getCollection<FinancialEventEntity>(this.db, COLLECTION)
  }

  constructor(private readonly db: Db) {}

  async ensureIndexes(): Promise<void> {
    await this.collection().createIndexes([
      { key: { eventKey: 1 }, unique: true, name: 'uniq_financial_event_key' },
      { key: { status: 1, createdAt: 1 }, name: 'financial_outbox_status_created' },
    ])
  }

  /** Devuelve true si el evento quedó encolado (nuevo o ya existente). */
  async enqueue(event: Omit<FinancialEventEntity, '_id' | 'status' | 'attempts' | 'createdAt' | 'lastError' | 'lockedUntil' | 'processedAt'>): Promise<boolean> {
    try {
      await this.collection().insertOne({
        ...event,
        status: 'pending',
        attempts: 0,
        lastError: null,
        lockedUntil: null,
        processedAt: null,
        createdAt: new Date(),
      } as never)
      return true
    } catch (error) {
      if (isDuplicateKey(error)) return true
      throw error
    }
  }

  /** Toma hasta `limit` eventos pendientes (o con arrendamiento vencido) y los bloquea. */
  async claimPending(limit: number, leaseMs = DEFAULT_LEASE_MS): Promise<FinancialEventEntity[]> {
    const claimed: FinancialEventEntity[] = []
    const now = new Date()
    for (let i = 0; i < limit; i++) {
      const doc = await this.collection().findOneAndUpdate(
        {
          $or: [
            { status: 'pending' },
            { status: 'processing', lockedUntil: { $lt: now } },
          ],
        } as never,
        {
          $set: { status: 'processing', lockedUntil: new Date(now.getTime() + leaseMs) },
          $inc: { attempts: 1 },
        },
        { sort: { createdAt: 1 }, returnDocument: 'after' },
      )
      if (!doc) break
      claimed.push(doc as FinancialEventEntity)
    }
    return claimed
  }

  async markProcessed(id: unknown): Promise<void> {
    await this.collection().updateOne(
      { _id: id } as never,
      { $set: { status: 'processed', processedAt: new Date(), lockedUntil: null, lastError: null } },
    )
  }

  /** Devuelve el evento a pendiente para reintento; guarda el último error. */
  async markFailed(id: unknown, error: string): Promise<void> {
    await this.collection().updateOne(
      { _id: id } as never,
      { $set: { status: 'pending', lockedUntil: null, lastError: error.slice(0, 500) } },
    )
  }

  async countByStatus(): Promise<Record<string, number>> {
    const rows = await this.collection()
      .aggregate<{ _id: string; count: number }>([{ $group: { _id: '$status', count: { $sum: 1 } } }])
      .toArray()
    return Object.fromEntries(rows.map((row) => [row._id, row.count]))
  }
}

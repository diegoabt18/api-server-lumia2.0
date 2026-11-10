import type { Db } from 'mongodb'
import { BaseRepository, getCollection } from '../../../database/repositories/base.repository.js'

export type AuthAuditEvent =
  | 'LOGIN_SUCCESS'
  | 'LOGIN_FAILED'
  | 'LOGIN_2FA_FAILED'
  | 'LOGOUT'

export interface AuthAuditEntry {
  _id?: string
  event: AuthAuditEvent
  userId?: string | null
  email?: string | null
  ip?: string | null
  userAgent?: string | null
  metadata?: Record<string, unknown>
  /** null si el registro no tiene fecha válida (no debería ocurrir en registros nuevos). */
  createdAt: Date | null
}

interface AuthAuditDocument {
  event: AuthAuditEvent
  userId?: string | null
  email?: string | null
  ip?: string | null
  userAgent?: string | null
  metadata?: Record<string, unknown>
  createdAt: Date
  /** Registros escritos por Lumia en modo `embedded`: guardan la fecha en `timestamp`, no en `createdAt`. */
  timestamp?: Date
}

function validDate(value: unknown): Date | null {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value : null
}

function toEntity(doc: AuthAuditDocument & { _id: { toString(): string } }): AuthAuditEntry {
  return {
    _id: doc._id.toString(),
    event: doc.event,
    userId: doc.userId ?? null,
    email: doc.email ?? null,
    ip: doc.ip ?? null,
    userAgent: doc.userAgent ?? null,
    metadata: doc.metadata,
    createdAt: validDate(doc.createdAt) ?? validDate(doc.timestamp),
  }
}

export class AuthAuditRepository extends BaseRepository<AuthAuditDocument> {
  constructor(db: Db) {
    super(getCollection(db, 'auth_audit_log'))
  }

  async ensureIndexes(): Promise<void> {
    await super.ensureIndexes([
      { key: { createdAt: -1 } },
      { key: { userId: 1, createdAt: -1 }, sparse: true },
      { key: { event: 1, createdAt: -1 } },
    ])
  }

  async log(entry: Omit<AuthAuditEntry, '_id' | 'createdAt'>): Promise<void> {
    await this.insertOne({
      ...entry,
      createdAt: new Date(),
    } as AuthAuditDocument)
  }

  async listRecent(limit = 50): Promise<AuthAuditEntry[]> {
    const docs = await this.collection
      .find({})
      .sort({ createdAt: -1, timestamp: -1 })
      .limit(limit)
      .toArray()
    return docs.map((d) => toEntity(d as never))
  }

  async query(opts: {
    userId?: string
    event?: AuthAuditEvent
    from?: Date
    to?: Date
    limit: number
    skip: number
    search?: string
  }): Promise<{ items: AuthAuditEntry[]; total: number }> {
    const filter: Record<string, unknown> = {}
    if (opts.userId) filter.userId = opts.userId
    if (opts.event) filter.event = opts.event
    const and: Record<string, unknown>[] = []
    if (opts.from || opts.to) {
      const range: Record<string, Date> = {}
      if (opts.from) range.$gte = opts.from
      if (opts.to) range.$lte = opts.to
      // Los registros de Lumia `embedded` solo tienen `timestamp`.
      and.push({ $or: [{ createdAt: range }, { createdAt: { $exists: false }, timestamp: range }] })
    }
    if (opts.search?.trim()) {
      const rx = new RegExp(opts.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      and.push({ $or: [{ email: rx }, { event: rx }, { ip: rx }] })
    }
    if (and.length) filter.$and = and

    const [docs, total] = await Promise.all([
      this.collection
        .find(filter as never)
        .sort({ createdAt: -1, timestamp: -1 })
        .skip(opts.skip)
        .limit(opts.limit)
        .toArray(),
      this.count(filter as never),
    ])
    return { items: docs.map((d) => toEntity(d as never)), total }
  }

  async countSince(since: Date): Promise<{ failedLogins: number; reuseDetected: number }> {
    const [failedLogins, reuseDetected] = await Promise.all([
      this.collection.countDocuments({
        createdAt: { $gte: since },
        event: 'LOGIN_FAILED',
      } as never),
      this.collection.countDocuments({
        createdAt: { $gte: since },
        event: 'LOGIN_SUCCESS',
        'metadata.reuseDetected': true,
      } as never),
    ])
    return { failedLogins, reuseDetected }
  }
}

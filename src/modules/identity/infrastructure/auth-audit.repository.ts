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
  createdAt: Date
}

interface AuthAuditDocument {
  event: AuthAuditEvent
  userId?: string | null
  email?: string | null
  ip?: string | null
  userAgent?: string | null
  metadata?: Record<string, unknown>
  createdAt: Date
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
    createdAt: doc.createdAt,
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
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray()
    return docs.map((d) => toEntity(d as never))
  }
}

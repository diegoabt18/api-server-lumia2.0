import { ObjectId, type Db, type Document, type Filter } from 'mongodb'
import { BaseRepository, getCollection } from '../../../database/repositories/base.repository.js'
import type {
  AuditAction,
  AuditEntityType,
  PermissionAuditEntry,
} from '../domain/enterprise.entities.js'

interface AuditDocument extends Document {
  entityType: AuditEntityType
  entityId: string
  entityLabel: string
  action: AuditAction
  changedBy: string
  changedByEmail?: string | null
  before?: Record<string, unknown> | null
  after?: Record<string, unknown> | null
  summary: string
  ip?: string | null
  metadata?: Record<string, unknown>
  timestamp: Date
}

function toEntity(doc: AuditDocument & { _id: ObjectId }): PermissionAuditEntry {
  return {
    _id: doc._id.toString(),
    entityType: doc.entityType,
    entityId: doc.entityId,
    entityLabel: doc.entityLabel,
    action: doc.action,
    changedBy: doc.changedBy,
    changedByEmail: doc.changedByEmail ?? null,
    before: doc.before ?? null,
    after: doc.after ?? null,
    summary: doc.summary,
    ip: doc.ip ?? null,
    metadata: doc.metadata ?? {},
    timestamp: doc.timestamp,
  }
}

export interface PermissionAuditFilters {
  page?: number
  limit?: number
  search?: string
  entityType?: AuditEntityType
  entityId?: string
  action?: AuditAction
  changedBy?: string
  dateFrom?: string
  dateTo?: string
}

export class PermissionAuditRepository extends BaseRepository<AuditDocument> {
  constructor(db: Db) {
    super(getCollection(db, 'permission_audit'))
  }

  async ensureIndexes(): Promise<void> {
    await super.ensureIndexes([
      { key: { entityType: 1, timestamp: -1 } },
      { key: { entityId: 1, timestamp: -1 } },
      { key: { changedBy: 1, timestamp: -1 } },
      { key: { action: 1, timestamp: -1 } },
      { key: { timestamp: -1 } },
    ])
  }

  async append(entry: Omit<PermissionAuditEntry, '_id'>): Promise<void> {
    await this.insertOne({
      ...entry,
      timestamp: entry.timestamp ?? new Date(),
    } as AuditDocument)
  }

  async list(filters: PermissionAuditFilters): Promise<{ items: PermissionAuditEntry[]; total: number }> {
    const match: Record<string, unknown> = {}
    if (filters.entityType) match.entityType = filters.entityType
    if (filters.entityId) match.entityId = filters.entityId
    if (filters.action) match.action = filters.action
    if (filters.changedBy) match.changedBy = filters.changedBy
    if (filters.dateFrom || filters.dateTo) {
      const ts: Record<string, Date> = {}
      if (filters.dateFrom) {
        const from = new Date(filters.dateFrom)
        if (!Number.isNaN(from.getTime())) ts.$gte = from
      }
      if (filters.dateTo) {
        const to = new Date(filters.dateTo)
        if (!Number.isNaN(to.getTime())) ts.$lte = to
      }
      if (Object.keys(ts).length) match.timestamp = ts
    }
    if (filters.search?.trim()) {
      const rx = filters.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      match.$or = [
        { summary: { $regex: rx, $options: 'i' } },
        { entityLabel: { $regex: rx, $options: 'i' } },
        { entityId: { $regex: rx, $options: 'i' } },
      ]
    }
    const page = Math.max(1, filters.page ?? 1)
    const limit = Math.min(200, Math.max(1, filters.limit ?? 50))
    const skip = (page - 1) * limit
    const [docs, total] = await Promise.all([
      this.findMany(match as Filter<AuditDocument>, { sort: { timestamp: -1 }, skip, limit }),
      this.count(match as Filter<AuditDocument>),
    ])
    return { items: docs.map((d) => toEntity(d)), total }
  }

  async findByIdSafe(id: string): Promise<PermissionAuditEntry | null> {
    const doc = await this.findById(id)
    return doc ? toEntity(doc) : null
  }

  async getStats(): Promise<{
    totalEntries: number
    byEntityType: Record<string, number>
    byAction: Record<string, number>
    recentDays: number
  }> {
    const totalEntries = await this.count()
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    const [byEntityType, byAction] = await Promise.all([
      this.collection
        .aggregate([{ $match: { timestamp: { $gte: sevenDaysAgo } } }, { $group: { _id: '$entityType', count: { $sum: 1 } } }])
        .toArray(),
      this.collection
        .aggregate([{ $match: { timestamp: { $gte: sevenDaysAgo } } }, { $group: { _id: '$action', count: { $sum: 1 } } }])
        .toArray(),
    ])
    const entityMap: Record<string, number> = {}
    for (const e of byEntityType) entityMap[String(e._id)] = e.count as number
    const actionMap: Record<string, number> = {}
    for (const a of byAction) actionMap[String(a._id)] = a.count as number
    return { totalEntries, byEntityType: entityMap, byAction: actionMap, recentDays: 7 }
  }
}

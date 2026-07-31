import type { Db, Filter } from 'mongodb'
import { ObjectId } from 'mongodb'
import { BaseRepository, getCollection } from '../../../database/repositories/base.repository.js'
import {
  toProductionAuditDomain,
  type ProductionAuditEntryDomain,
  type ProductionAuditEntryEntity,
  type ProductionAuditEventType,
} from '../domain/production-audit.entity.js'

export interface AuditListFilters {
  eventType?: ProductionAuditEventType
  entityType?: string
  entityId?: string
  performedBy?: string
  from?: string
  to?: string
  limit: number
  offset: number
}

export class ProductionAuditRepository extends BaseRepository<ProductionAuditEntryEntity> {
  constructor(db: Db) {
    super(getCollection<ProductionAuditEntryEntity>(db, 'production_audit_log'))
  }

  async ensureIndexes(): Promise<void> {
    await super.ensureIndexes([
      { key: { created_at: -1 } },
      { key: { event_type: 1, entity_type: 1 } },
    ])
  }

  async insert(entry: Omit<ProductionAuditEntryEntity, '_id'>): Promise<void> {
    await this.insertOne(entry as never)
  }

  async list(filters: AuditListFilters): Promise<{ items: ProductionAuditEntryDomain[]; total: number }> {
    const filter = this.buildFilter(filters)
    const [docs, total] = await Promise.all([
      this.findMany(filter, { skip: filters.offset, limit: filters.limit, sort: { created_at: -1 } }),
      this.count(filter),
    ])
    return { items: docs.map(toProductionAuditDomain), total }
  }

  private buildFilter(filters: AuditListFilters): Filter<ProductionAuditEntryEntity> {
    const parts: Filter<ProductionAuditEntryEntity>[] = []
    if (filters.eventType) parts.push({ event_type: filters.eventType } as Filter<ProductionAuditEntryEntity>)
    if (filters.entityType) parts.push({ entity_type: filters.entityType } as Filter<ProductionAuditEntryEntity>)
    if (filters.entityId) parts.push({ entity_id: filters.entityId } as Filter<ProductionAuditEntryEntity>)
    if (filters.performedBy && ObjectId.isValid(filters.performedBy)) {
      parts.push({ performed_by: new ObjectId(filters.performedBy) } as Filter<ProductionAuditEntryEntity>)
    }
    if (filters.from || filters.to) {
      const createdAt: Record<string, Date> = {}
      if (filters.from) createdAt.$gte = new Date(filters.from)
      if (filters.to) createdAt.$lte = new Date(filters.to)
      parts.push({ created_at: createdAt } as Filter<ProductionAuditEntryEntity>)
    }
    if (!parts.length) return {}
    if (parts.length === 1) return parts[0]!
    return { $and: parts } as Filter<ProductionAuditEntryEntity>
  }
}

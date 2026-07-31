import { ObjectId, type Db, type Document, type Filter } from 'mongodb'
import { BaseRepository, getCollection } from '../../../database/repositories/base.repository.js'
import type {
  ScheduledActionType,
  ScheduledChangeEntity,
  ScheduledChangeStatus,
} from '../domain/enterprise.entities.js'

interface ScheduledDocument extends Document {
  action: ScheduledActionType
  payload: Record<string, unknown>
  summary: string
  executeAt: Date
  expiresAt?: Date | null
  status: ScheduledChangeStatus
  createdBy: string
  executedAt?: Date | null
  executionResult?: string | null
  createdAt: Date
  updatedAt: Date
}

function toEntity(doc: ScheduledDocument & { _id: ObjectId }): ScheduledChangeEntity {
  return {
    _id: doc._id.toString(),
    action: doc.action,
    payload: doc.payload ?? {},
    summary: doc.summary ?? '',
    executeAt: doc.executeAt,
    expiresAt: doc.expiresAt ?? null,
    status: doc.status ?? 'scheduled',
    createdBy: doc.createdBy,
    executedAt: doc.executedAt ?? null,
    executionResult: doc.executionResult ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  }
}

export interface ScheduledFilters {
  page?: number
  limit?: number
  search?: string
  status?: ScheduledChangeStatus
  action?: ScheduledActionType
  createdBy?: string
}

export class ScheduledChangeRepository extends BaseRepository<ScheduledDocument> {
  constructor(db: Db) {
    super(getCollection(db, 'scheduled_changes'))
  }

  async ensureIndexes(): Promise<void> {
    await super.ensureIndexes([
      { key: { status: 1, executeAt: 1 } },
      { key: { createdBy: 1 } },
      { key: { action: 1 } },
    ])
  }

  async findByIdSafe(id: string): Promise<ScheduledChangeEntity | null> {
    const doc = await this.findById(id)
    return doc ? toEntity(doc) : null
  }

  async list(filters: ScheduledFilters): Promise<{ items: ScheduledChangeEntity[]; total: number }> {
    const match: Record<string, unknown> = {}
    if (filters.status) match.status = filters.status
    if (filters.action) match.action = filters.action
    if (filters.createdBy) match.createdBy = filters.createdBy
    if (filters.search?.trim()) {
      const rx = filters.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      match.$or = [{ summary: { $regex: rx, $options: 'i' } }, { createdBy: { $regex: rx, $options: 'i' } }]
    }
    const page = Math.max(1, filters.page ?? 1)
    const limit = Math.min(100, Math.max(1, filters.limit ?? 20))
    const skip = (page - 1) * limit
    const [docs, total] = await Promise.all([
      this.findMany(match as Filter<ScheduledDocument>, { sort: { executeAt: 1 }, skip, limit }),
      this.count(match as Filter<ScheduledDocument>),
    ])
    return { items: docs.map((d) => toEntity(d)), total }
  }

  async findPendingDue(): Promise<ScheduledChangeEntity[]> {
    const now = new Date()
    const docs = await this.findMany({
      status: 'scheduled',
      executeAt: { $lte: now },
    } as Filter<ScheduledDocument>, { sort: { executeAt: 1 } })
    return docs.map((d) => toEntity(d))
  }

  async create(input: {
    action: ScheduledActionType
    payload: Record<string, unknown>
    summary: string
    executeAt: Date
    expiresAt?: Date | null
    createdBy: string
  }): Promise<ScheduledChangeEntity> {
    const now = new Date()
    const id = await this.insertOne({
      action: input.action,
      payload: input.payload,
      summary: input.summary,
      executeAt: input.executeAt,
      expiresAt: input.expiresAt ?? null,
      status: 'scheduled',
      createdBy: input.createdBy,
      executedAt: null,
      executionResult: null,
      createdAt: now,
      updatedAt: now,
    } as ScheduledDocument)
    return (await this.findByIdSafe(id))!
  }

  async markExecuted(id: string, result: string): Promise<boolean> {
    if (!ObjectId.isValid(id)) return false
    const res = await this.collection.updateOne(
      { _id: new ObjectId(id), status: 'scheduled' } as Filter<ScheduledDocument>,
      { $set: { status: 'executed', executedAt: new Date(), executionResult: result, updatedAt: new Date() } },
    )
    return res.modifiedCount > 0
  }

  async cancel(id: string): Promise<boolean> {
    if (!ObjectId.isValid(id)) return false
    const res = await this.collection.updateOne(
      { _id: new ObjectId(id), status: 'scheduled' } as Filter<ScheduledDocument>,
      { $set: { status: 'cancelled', updatedAt: new Date() } },
    )
    return res.modifiedCount > 0
  }
}

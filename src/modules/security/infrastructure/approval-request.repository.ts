import { ObjectId, type Db, type Document, type Filter } from 'mongodb'
import { BaseRepository, getCollection } from '../../../database/repositories/base.repository.js'
import type {
  ApprovalRequestEntity,
  ApprovalStatus,
  SensitiveAction,
} from '../domain/enterprise.entities.js'

interface ApprovalDocument extends Document {
  action: SensitiveAction
  payload: Record<string, unknown>
  summary: string
  risk: 'low' | 'medium' | 'high'
  requestedBy: string
  reviewedBy?: string | null
  status: ApprovalStatus
  reviewedAt?: Date | null
  rejectionReason?: string | null
  context?: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}

function toEntity(doc: ApprovalDocument & { _id: ObjectId }): ApprovalRequestEntity {
  return {
    _id: doc._id.toString(),
    action: doc.action,
    payload: doc.payload ?? {},
    summary: doc.summary ?? '',
    risk: doc.risk ?? 'medium',
    requestedBy: doc.requestedBy,
    reviewedBy: doc.reviewedBy ?? null,
    status: doc.status ?? 'pending',
    reviewedAt: doc.reviewedAt ?? null,
    rejectionReason: doc.rejectionReason ?? null,
    context: doc.context ?? {},
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  }
}

export interface ApprovalFilters {
  page?: number
  limit?: number
  search?: string
  status?: ApprovalStatus
  action?: SensitiveAction
  requestedBy?: string
  risk?: string
}

export class ApprovalRequestRepository extends BaseRepository<ApprovalDocument> {
  constructor(db: Db) {
    super(getCollection(db, 'approval_requests'))
  }

  async ensureIndexes(): Promise<void> {
    await super.ensureIndexes([
      { key: { status: 1, createdAt: -1 } },
      { key: { requestedBy: 1, status: 1 } },
      { key: { action: 1 } },
    ])
  }

  async findByIdSafe(id: string): Promise<ApprovalRequestEntity | null> {
    const doc = await this.findById(id)
    return doc ? toEntity(doc) : null
  }

  async list(filters: ApprovalFilters): Promise<{ items: ApprovalRequestEntity[]; total: number }> {
    const match: Record<string, unknown> = {}
    if (filters.status) match.status = filters.status
    if (filters.action) match.action = filters.action
    if (filters.requestedBy) match.requestedBy = filters.requestedBy
    if (filters.risk) match.risk = filters.risk
    if (filters.search?.trim()) {
      const rx = filters.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      match.$or = [{ summary: { $regex: rx, $options: 'i' } }, { requestedBy: { $regex: rx, $options: 'i' } }]
    }
    const page = Math.max(1, filters.page ?? 1)
    const limit = Math.min(100, Math.max(1, filters.limit ?? 20))
    const skip = (page - 1) * limit
    const [docs, total] = await Promise.all([
      this.findMany(match as Filter<ApprovalDocument>, { sort: { createdAt: -1 }, skip, limit }),
      this.count(match as Filter<ApprovalDocument>),
    ])
    return { items: docs.map((d) => toEntity(d)), total }
  }

  async countPending(): Promise<number> {
    return this.count({ status: 'pending' } as Filter<ApprovalDocument>)
  }

  async create(input: {
    action: SensitiveAction
    payload: Record<string, unknown>
    summary: string
    risk?: 'low' | 'medium' | 'high'
    requestedBy: string
    context?: Record<string, unknown>
  }): Promise<ApprovalRequestEntity> {
    const now = new Date()
    const id = await this.insertOne({
      action: input.action,
      payload: input.payload,
      summary: input.summary,
      risk: input.risk ?? 'medium',
      requestedBy: input.requestedBy,
      reviewedBy: null,
      status: 'pending',
      reviewedAt: null,
      rejectionReason: null,
      context: input.context ?? {},
      createdAt: now,
      updatedAt: now,
    } as ApprovalDocument)
    return (await this.findByIdSafe(id))!
  }

  async approve(id: string, reviewedBy: string): Promise<boolean> {
    if (!ObjectId.isValid(id)) return false
    const res = await this.collection.updateOne(
      { _id: new ObjectId(id), status: 'pending' } as Filter<ApprovalDocument>,
      { $set: { status: 'approved', reviewedBy, reviewedAt: new Date(), updatedAt: new Date() } },
    )
    return res.modifiedCount > 0
  }

  async reject(id: string, reviewedBy: string, reason?: string): Promise<boolean> {
    if (!ObjectId.isValid(id)) return false
    const res = await this.collection.updateOne(
      { _id: new ObjectId(id), status: 'pending' } as Filter<ApprovalDocument>,
      {
        $set: {
          status: 'rejected',
          reviewedBy,
          reviewedAt: new Date(),
          rejectionReason: reason ?? null,
          updatedAt: new Date(),
        },
      },
    )
    return res.modifiedCount > 0
  }
}

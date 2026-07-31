import { ObjectId, type Db, type Document, type Filter } from 'mongodb'
import {
  expandPermissions,
} from '../../../common/permissions/registry.js'
import { BaseRepository, getCollection } from '../../../database/repositories/base.repository.js'
import type {
  ListFilters,
  TemporalPermissionEntity,
  TemporalPermissionStatus,
} from '../domain/enterprise.entities.js'

interface TemporalPermissionDocument extends Document {
  userId: string
  grantedBy: string
  permissionKeys: string[]
  reason: string
  startsAt: Date
  expiresAt: Date
  status: TemporalPermissionStatus
  revokedAt?: Date | null
  revokedBy?: string | null
  metadata?: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}

function toEntity(doc: TemporalPermissionDocument & { _id: ObjectId }): TemporalPermissionEntity {
  return {
    _id: doc._id.toString(),
    userId: doc.userId,
    grantedBy: doc.grantedBy,
    permissionKeys: expandPermissions(doc.permissionKeys ?? []),
    reason: doc.reason ?? '',
    startsAt: doc.startsAt,
    expiresAt: doc.expiresAt,
    status: doc.status ?? 'active',
    revokedAt: doc.revokedAt ?? null,
    revokedBy: doc.revokedBy ?? null,
    metadata: doc.metadata ?? {},
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  }
}

function buildMatch(filters: ListFilters): Record<string, unknown> {
  const match: Record<string, unknown> = {}
  if (filters.userId) match.userId = filters.userId
  if (filters.grantedBy) match.grantedBy = filters.grantedBy
  if (filters.status && filters.status !== 'all') {
    match.status = filters.status
  } else if (!filters.includeExpired) {
    match.status = { $ne: 'expired' }
  }
  if (filters.search?.trim()) {
    const rx = filters.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    match.$or = [{ reason: { $regex: rx, $options: 'i' } }, { userId: { $regex: rx, $options: 'i' } }]
  }
  return match
}

export class TemporalPermissionRepository extends BaseRepository<TemporalPermissionDocument> {
  constructor(db: Db) {
    super(getCollection(db, 'temporal_permissions'))
  }

  async ensureIndexes(): Promise<void> {
    await super.ensureIndexes([
      { key: { userId: 1, status: 1 } },
      { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
      { key: { grantedBy: 1 } },
      { key: { status: 1 } },
    ])
  }

  async findByIdSafe(id: string): Promise<TemporalPermissionEntity | null> {
    const doc = await this.findById(id)
    return doc ? toEntity(doc) : null
  }

  async list(filters: ListFilters): Promise<{ items: TemporalPermissionEntity[]; total: number }> {
    const match = buildMatch(filters)
    const page = Math.max(1, filters.page ?? 1)
    const limit = Math.min(100, Math.max(1, filters.limit ?? 20))
    const skip = (page - 1) * limit
    const [docs, total] = await Promise.all([
      this.findMany(match as Filter<TemporalPermissionDocument>, {
        sort: { createdAt: -1 },
        skip,
        limit,
      }),
      this.count(match as Filter<TemporalPermissionDocument>),
    ])
    return { items: docs.map((d) => toEntity(d)), total }
  }

  async findActiveByUserId(userId: string): Promise<TemporalPermissionEntity[]> {
    const now = new Date()
    const docs = await this.findMany({
      userId,
      status: 'active',
      startsAt: { $lte: now },
      expiresAt: { $gt: now },
    } as Filter<TemporalPermissionDocument>)
    return docs.map((d) => toEntity(d))
  }

  async create(input: {
    userId: string
    grantedBy: string
    permissionKeys: string[]
    reason: string
    startsAt: Date
    expiresAt: Date
    metadata?: Record<string, unknown>
  }): Promise<TemporalPermissionEntity> {
    const now = new Date()
    const id = await this.insertOne({
      userId: input.userId,
      grantedBy: input.grantedBy,
      permissionKeys: expandPermissions(input.permissionKeys),
      reason: input.reason.trim(),
      startsAt: input.startsAt,
      expiresAt: input.expiresAt,
      status: 'active',
      revokedAt: null,
      revokedBy: null,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    } as TemporalPermissionDocument)
    return (await this.findByIdSafe(id))!
  }

  async revoke(id: string, revokedBy: string): Promise<boolean> {
    if (!ObjectId.isValid(id)) return false
    const res = await this.collection.updateOne(
      { _id: new ObjectId(id), status: 'active' } as Filter<TemporalPermissionDocument>,
      { $set: { status: 'revoked', revokedAt: new Date(), revokedBy, updatedAt: new Date() } },
    )
    return res.modifiedCount > 0
  }

  async expireAllOverdue(): Promise<number> {
    const now = new Date()
    const res = await this.collection.updateMany(
      { status: 'active', expiresAt: { $lt: now } } as Filter<TemporalPermissionDocument>,
      { $set: { status: 'expired', updatedAt: now } },
    )
    return res.modifiedCount
  }

  async countActiveByUser(userId: string): Promise<number> {
    const now = new Date()
    return this.count({
      userId,
      status: 'active',
      startsAt: { $lte: now },
      expiresAt: { $gt: now },
    } as Filter<TemporalPermissionDocument>)
  }
}

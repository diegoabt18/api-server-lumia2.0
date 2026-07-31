import { ObjectId, type Db, type Document, type Filter } from 'mongodb'
import { expandPermissions } from '../../../common/permissions/registry.js'
import { BaseRepository, getCollection } from '../../../database/repositories/base.repository.js'
import type {
  ListFilters,
  OverrideStatus,
  UserPermissionOverrideEntity,
} from '../domain/enterprise.entities.js'

interface OverrideDocument extends Document {
  userId: string
  permissionKeys: string[]
  grantedBy: string
  reason: string
  status: OverrideStatus
  revokedAt?: Date | null
  revokedBy?: string | null
  createdAt: Date
  updatedAt: Date
}

function toEntity(doc: OverrideDocument & { _id: ObjectId }): UserPermissionOverrideEntity {
  return {
    _id: doc._id.toString(),
    userId: doc.userId,
    permissionKeys: expandPermissions(doc.permissionKeys ?? []),
    grantedBy: doc.grantedBy,
    reason: doc.reason ?? '',
    status: doc.status ?? 'active',
    revokedAt: doc.revokedAt ?? null,
    revokedBy: doc.revokedBy ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  }
}

export class UserPermissionOverrideRepository extends BaseRepository<OverrideDocument> {
  constructor(db: Db) {
    super(getCollection(db, 'user_permission_overrides'))
  }

  async ensureIndexes(): Promise<void> {
    await super.ensureIndexes([
      { key: { userId: 1, status: 1 } },
      { key: { grantedBy: 1 } },
      { key: { status: 1 } },
    ])
  }

  async findByIdSafe(id: string): Promise<UserPermissionOverrideEntity | null> {
    const doc = await this.findById(id)
    return doc ? toEntity(doc) : null
  }

  async list(filters: ListFilters): Promise<{ items: UserPermissionOverrideEntity[]; total: number }> {
    const match: Record<string, unknown> = {}
    if (filters.userId) match.userId = filters.userId
    if (filters.grantedBy) match.grantedBy = filters.grantedBy
    if (filters.status) match.status = filters.status
    if (filters.search?.trim()) {
      const rx = filters.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      match.$or = [{ reason: { $regex: rx, $options: 'i' } }, { userId: { $regex: rx, $options: 'i' } }]
    }
    const page = Math.max(1, filters.page ?? 1)
    const limit = Math.min(100, Math.max(1, filters.limit ?? 20))
    const skip = (page - 1) * limit
    const [docs, total] = await Promise.all([
      this.findMany(match as Filter<OverrideDocument>, { sort: { createdAt: -1 }, skip, limit }),
      this.count(match as Filter<OverrideDocument>),
    ])
    return { items: docs.map((d) => toEntity(d)), total }
  }

  async findActiveByUserId(userId: string): Promise<UserPermissionOverrideEntity[]> {
    const docs = await this.findMany({ userId, status: 'active' } as Filter<OverrideDocument>)
    return docs.map((d) => toEntity(d))
  }

  async create(input: {
    userId: string
    grantedBy: string
    permissionKeys: string[]
    reason: string
  }): Promise<UserPermissionOverrideEntity> {
    const now = new Date()
    const id = await this.insertOne({
      userId: input.userId,
      grantedBy: input.grantedBy,
      permissionKeys: expandPermissions(input.permissionKeys),
      reason: input.reason.trim(),
      status: 'active',
      revokedAt: null,
      revokedBy: null,
      createdAt: now,
      updatedAt: now,
    } as OverrideDocument)
    return (await this.findByIdSafe(id))!
  }

  async revoke(id: string, revokedBy: string): Promise<boolean> {
    if (!ObjectId.isValid(id)) return false
    const res = await this.collection.updateOne(
      { _id: new ObjectId(id), status: 'active' } as Filter<OverrideDocument>,
      { $set: { status: 'revoked', revokedAt: new Date(), revokedBy, updatedAt: new Date() } },
    )
    return res.modifiedCount > 0
  }

  async countActiveByUser(userId: string): Promise<number> {
    return this.count({ userId, status: 'active' } as Filter<OverrideDocument>)
  }
}

import { ObjectId, type Db, type Document, type Filter } from 'mongodb'
import { BaseRepository, getCollection } from '../../../database/repositories/base.repository.js'
import type {
  DelegationStatus,
  ListFilters,
  RoleDelegationEntity,
} from '../domain/enterprise.entities.js'

interface DelegationDocument extends Document {
  userId: string
  roleId: string
  roleName?: string | null
  roleKey?: string | null
  delegatedBy: string
  reason: string
  startsAt: Date
  expiresAt: Date
  status: DelegationStatus
  revokedAt?: Date | null
  revokedBy?: string | null
  createdAt: Date
  updatedAt: Date
}

function toEntity(doc: DelegationDocument & { _id: ObjectId }): RoleDelegationEntity {
  return {
    _id: doc._id.toString(),
    userId: doc.userId,
    roleId: doc.roleId,
    roleName: doc.roleName ?? null,
    roleKey: doc.roleKey ?? null,
    delegatedBy: doc.delegatedBy,
    reason: doc.reason ?? '',
    startsAt: doc.startsAt,
    expiresAt: doc.expiresAt,
    status: doc.status ?? 'active',
    revokedAt: doc.revokedAt ?? null,
    revokedBy: doc.revokedBy ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  }
}

export class RoleDelegationRepository extends BaseRepository<DelegationDocument> {
  constructor(db: Db) {
    super(getCollection(db, 'role_delegations'))
  }

  async ensureIndexes(): Promise<void> {
    await super.ensureIndexes([
      { key: { userId: 1, status: 1 } },
      { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
      { key: { delegatedBy: 1 } },
      { key: { roleId: 1 } },
    ])
  }

  async findByIdSafe(id: string): Promise<RoleDelegationEntity | null> {
    const doc = await this.findById(id)
    return doc ? toEntity(doc) : null
  }

  async list(filters: ListFilters): Promise<{ items: RoleDelegationEntity[]; total: number }> {
    const match: Record<string, unknown> = {}
    if (filters.userId) match.userId = filters.userId
    if (filters.delegatedBy) match.delegatedBy = filters.delegatedBy
    if (filters.roleId) match.roleId = filters.roleId
    if (filters.status && filters.status !== 'all') {
      match.status = filters.status
    } else if (!filters.includeExpired) {
      match.status = { $ne: 'expired' }
    }
    if (filters.search?.trim()) {
      const rx = filters.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      match.$or = [{ reason: { $regex: rx, $options: 'i' } }, { userId: { $regex: rx, $options: 'i' } }]
    }
    const page = Math.max(1, filters.page ?? 1)
    const limit = Math.min(100, Math.max(1, filters.limit ?? 20))
    const skip = (page - 1) * limit
    const [docs, total] = await Promise.all([
      this.findMany(match as Filter<DelegationDocument>, { sort: { createdAt: -1 }, skip, limit }),
      this.count(match as Filter<DelegationDocument>),
    ])
    return { items: docs.map((d) => toEntity(d)), total }
  }

  async findActiveByUserId(userId: string): Promise<RoleDelegationEntity[]> {
    const now = new Date()
    const docs = await this.findMany({
      userId,
      status: 'active',
      startsAt: { $lte: now },
      expiresAt: { $gt: now },
    } as Filter<DelegationDocument>)
    return docs.map((d) => toEntity(d))
  }

  async create(input: {
    userId: string
    roleId: string
    roleName?: string
    roleKey?: string
    delegatedBy: string
    reason: string
    startsAt: Date
    expiresAt: Date
  }): Promise<RoleDelegationEntity> {
    const now = new Date()
    const id = await this.insertOne({
      userId: input.userId,
      roleId: input.roleId,
      roleName: input.roleName ?? null,
      roleKey: input.roleKey ?? null,
      delegatedBy: input.delegatedBy,
      reason: input.reason.trim(),
      startsAt: input.startsAt,
      expiresAt: input.expiresAt,
      status: 'active',
      revokedAt: null,
      revokedBy: null,
      createdAt: now,
      updatedAt: now,
    } as DelegationDocument)
    return (await this.findByIdSafe(id))!
  }

  async revoke(id: string, revokedBy: string): Promise<boolean> {
    if (!ObjectId.isValid(id)) return false
    const res = await this.collection.updateOne(
      { _id: new ObjectId(id), status: 'active' } as Filter<DelegationDocument>,
      { $set: { status: 'revoked', revokedAt: new Date(), revokedBy, updatedAt: new Date() } },
    )
    return res.modifiedCount > 0
  }

  async expireAllOverdue(): Promise<number> {
    const now = new Date()
    const res = await this.collection.updateMany(
      { status: 'active', expiresAt: { $lt: now } } as Filter<DelegationDocument>,
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
    } as Filter<DelegationDocument>)
  }
}

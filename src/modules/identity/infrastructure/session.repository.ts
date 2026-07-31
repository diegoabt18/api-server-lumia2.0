import { ObjectId, type Db } from 'mongodb'
import { BaseRepository, getCollection } from '../../../database/repositories/base.repository.js'
import type { SessionEntity, SessionDeviceType } from '../domain/session.entity.js'

interface SessionDocument {
  _id: ObjectId
  userId: ObjectId
  refreshTokenHash?: string
  deviceId: string
  tokenFamilyId?: string
  parentTokenId?: ObjectId | null
  ipAddress?: string
  userAgent?: string
  deviceName?: string
  browser?: string
  os?: string
  deviceType?: SessionDeviceType
  expiresAt: Date
  revokedAt?: Date | null
  replacedByTokenId?: ObjectId | null
  createdAt: Date
  lastUsedAt: Date
  lastRefreshAt?: Date
  lastCountry?: string | null
  reuseDetected?: boolean
  suspicious?: boolean
  riskScore?: number
  isActive?: boolean
  permissionsVersion?: number
  permissionUpdatedAt?: Date
}

function toEntity(doc: SessionDocument): SessionEntity {
  const revoked = !!doc.revokedAt
  return {
    _id: doc._id.toString(),
    userId: doc.userId.toString(),
    refreshTokenHash: doc.refreshTokenHash ?? '',
    deviceId: doc.deviceId,
    tokenFamilyId: doc.tokenFamilyId ?? doc._id.toString(),
    parentTokenId: doc.parentTokenId?.toString() ?? null,
    ipAddress: doc.ipAddress,
    userAgent: doc.userAgent,
    deviceName: doc.deviceName,
    browser: doc.browser,
    os: doc.os,
    deviceType: doc.deviceType,
    expiresAt: doc.expiresAt,
    revokedAt: doc.revokedAt ?? null,
    replacedByTokenId: doc.replacedByTokenId?.toString() ?? null,
    createdAt: doc.createdAt,
    lastUsedAt: doc.lastUsedAt,
    lastRefreshAt: doc.lastRefreshAt,
    lastCountry: doc.lastCountry ?? null,
    reuseDetected: doc.reuseDetected,
    suspicious: doc.suspicious,
    riskScore: doc.riskScore,
    isActive: doc.isActive === false ? false : !revoked,
    permissionsVersion: doc.permissionsVersion ?? 1,
    permissionUpdatedAt: doc.permissionUpdatedAt,
  }
}

function activeFilter() {
  return { $or: [{ revokedAt: null }, { revokedAt: { $exists: false } }] }
}

export class SessionRepository extends BaseRepository<SessionDocument> {
  constructor(db: Db) {
    super(getCollection(db, 'sessions'))
  }

  async ensureIndexes(): Promise<void> {
    await super.ensureIndexes([
      { key: { userId: 1, deviceId: 1 } },
      { key: { refreshTokenHash: 1 }, sparse: true },
      { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
      { key: { tokenFamilyId: 1 } },
    ])
  }

  async create(session: Omit<SessionEntity, '_id' | 'createdAt' | 'lastUsedAt'>): Promise<{ sessionId: string }> {
    const now = new Date()
    const doc: Omit<SessionDocument, '_id'> = {
      userId: new ObjectId(session.userId),
      refreshTokenHash: session.refreshTokenHash,
      deviceId: session.deviceId,
      tokenFamilyId: session.tokenFamilyId,
      parentTokenId: session.parentTokenId ? new ObjectId(session.parentTokenId) : null,
      ipAddress: session.ipAddress,
      userAgent: session.userAgent,
      deviceName: session.deviceName,
      browser: session.browser,
      os: session.os,
      deviceType: session.deviceType,
      expiresAt: session.expiresAt,
      revokedAt: null,
      replacedByTokenId: null,
      createdAt: now,
      lastUsedAt: now,
      lastRefreshAt: session.lastRefreshAt,
      lastCountry: session.lastCountry ?? null,
      suspicious: session.suspicious ?? false,
      riskScore: session.riskScore ?? 0,
      isActive: true,
      permissionsVersion: session.permissionsVersion ?? 1,
      permissionUpdatedAt: session.permissionUpdatedAt,
    }
    const sessionId = await this.insertOne(doc as SessionDocument)
    return { sessionId }
  }

  async findByIdSafe(id: string): Promise<SessionEntity | null> {
    const doc = await this.findById(id)
    return doc ? toEntity(doc) : null
  }

  async findByRefreshHash(hash: string): Promise<SessionEntity | null> {
    const doc = await this.findOne({ refreshTokenHash: hash, ...activeFilter() })
    return doc ? toEntity(doc) : null
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.collection.updateOne(
      { _id: new ObjectId(sessionId) },
      { $set: { revokedAt: new Date(), isActive: false } },
    )
  }

  async revokeFamily(tokenFamilyId: string): Promise<void> {
    await this.collection.updateMany(
      { tokenFamilyId, ...activeFilter() },
      { $set: { revokedAt: new Date(), isActive: false, reuseDetected: true } },
    )
  }

  async revokeSessionsForUserDevice(userId: string, deviceId: string): Promise<void> {
    await this.collection.updateMany(
      { userId: new ObjectId(userId), deviceId, ...activeFilter() },
      { $set: { revokedAt: new Date(), isActive: false } },
    )
  }

  async rotateRefresh(
    sessionId: string,
    newHash: string,
    newExpiresAt: Date,
  ): Promise<void> {
    const now = new Date()
    await this.collection.updateOne(
      { _id: new ObjectId(sessionId) },
      {
        $set: {
          refreshTokenHash: newHash,
          expiresAt: newExpiresAt,
          lastRefreshAt: now,
          lastUsedAt: now,
        },
      },
    )
  }

  async updateLastUsed(sessionId: string): Promise<void> {
    await this.collection.updateOne(
      { _id: new ObjectId(sessionId) },
      { $set: { lastUsedAt: new Date() } },
    )
  }

  async listActiveByUserId(userId: string): Promise<SessionEntity[]> {
    const docs = await this.findMany(
      {
        userId: new ObjectId(userId),
        ...activeFilter(),
        expiresAt: { $gt: new Date() },
      } as never,
      { sort: { lastUsedAt: -1 } },
    )
    return docs.map((d) => toEntity(d))
  }

  async revokeSessionIfOwned(sessionId: string, userId: string): Promise<boolean> {
    if (!ObjectId.isValid(sessionId)) return false
    const res = await this.collection.updateOne(
      { _id: new ObjectId(sessionId), userId: new ObjectId(userId), ...activeFilter() } as never,
      { $set: { revokedAt: new Date(), isActive: false } },
    )
    return res.matchedCount > 0
  }

  async revokeAllByUserId(userId: string): Promise<void> {
    await this.collection.updateMany(
      { userId: new ObjectId(userId), ...activeFilter() } as never,
      { $set: { revokedAt: new Date(), isActive: false } },
    )
  }

  async revokeAllExcept(userId: string, exceptSessionId: string): Promise<void> {
    await this.collection.updateMany(
      {
        userId: new ObjectId(userId),
        _id: { $ne: new ObjectId(exceptSessionId) },
        ...activeFilter(),
      } as never,
      { $set: { revokedAt: new Date(), isActive: false } },
    )
  }

  async countActive(): Promise<number> {
    return this.collection.countDocuments({
      ...activeFilter(),
      expiresAt: { $gt: new Date() },
    } as never)
  }

  async countActiveGlobally(): Promise<number> {
    return this.countActive()
  }

  async listActiveGlobally(limit: number, skip: number): Promise<SessionEntity[]> {
    const filter = {
      ...activeFilter(),
      expiresAt: { $gt: new Date() },
    }
    const docs = await this.collection
      .find(filter as never)
      .sort({ lastUsedAt: -1 })
      .skip(skip)
      .limit(limit)
      .toArray()
    return docs.map((d) => toEntity(d))
  }

  async revokeSessionAsAdmin(sessionId: string): Promise<boolean> {
    if (!ObjectId.isValid(sessionId)) return false
    const res = await this.collection.updateOne(
      { _id: new ObjectId(sessionId), ...activeFilter() } as never,
      { $set: { revokedAt: new Date(), isActive: false } },
    )
    return res.matchedCount > 0
  }

  async listForAdmin(opts: {
    userId?: string
    limit: number
    skip: number
  }): Promise<{ items: SessionEntity[]; total: number }> {
    const filter: Record<string, unknown> = {
      ...activeFilter(),
      expiresAt: { $gt: new Date() },
    }
    if (opts.userId && ObjectId.isValid(opts.userId)) {
      filter.userId = new ObjectId(opts.userId)
    }
    const [docs, total] = await Promise.all([
      this.collection
        .find(filter as never)
        .sort({ lastUsedAt: -1 })
        .skip(opts.skip)
        .limit(opts.limit)
        .toArray(),
      this.collection.countDocuments(filter as never),
    ])
    return { items: docs.map((d) => toEntity(d)), total }
  }
}

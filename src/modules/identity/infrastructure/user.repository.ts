import { ObjectId, type Db } from 'mongodb'
import { BaseRepository, getCollection } from '../../../database/repositories/base.repository.js'
import type {
  UserEntity,
  UserNotificationPreferences,
  UserShippingAddress,
  UserTwoFactor,
} from '../domain/user.entity.js'
import type { UserRole } from '../../../common/permissions/registry.js'

interface UserDocument {
  _id: ObjectId
  email: string
  name?: string
  nickname?: string
  passwordHash?: string
  role?: UserRole
  isStaff?: boolean
  googleId?: string
  avatar?: string
  provider?: 'local' | 'google'
  isFirstLogin?: boolean
  notificationPreferences?: UserNotificationPreferences
  shippingAddresses?: UserShippingAddress[]
  twoFactor?: UserTwoFactor
  permissionsVersion?: number
  permissionUpdatedAt?: Date
  createdAt?: Date
  updatedAt?: Date
}

function toEntity(doc: UserDocument): UserEntity {
  return {
    _id: doc._id.toString(),
    email: doc.email,
    name: doc.name,
    nickname: doc.nickname,
    passwordHash: doc.passwordHash,
    role: doc.role ?? 'user',
    isStaff: doc.isStaff,
    googleId: doc.googleId,
    avatar: doc.avatar,
    provider: doc.provider,
    isFirstLogin: doc.isFirstLogin,
    notificationPreferences: doc.notificationPreferences,
    shippingAddresses: doc.shippingAddresses,
    twoFactor: doc.twoFactor,
    permissionsVersion: doc.permissionsVersion,
    permissionUpdatedAt: doc.permissionUpdatedAt,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  }
}

export class UserRepository extends BaseRepository<UserDocument> {
  constructor(db: Db) {
    super(getCollection(db, 'users'))
  }

  async ensureIndexes(): Promise<void> {
    await super.ensureIndexes([
      { key: { email: 1 }, unique: true },
      {
        key: { nickname: 1 },
        unique: true,
        partialFilterExpression: { nickname: { $type: 'string' } },
      },
      { key: { googleId: 1 }, sparse: true },
    ])
  }

  async findByEmail(email: string): Promise<UserEntity | null> {
    const doc = await this.findOne({ email: email.toLowerCase().trim() })
    return doc ? toEntity(doc) : null
  }

  async findByNickname(nickname: string): Promise<UserEntity | null> {
    const doc = await this.findOne({ nickname: nickname.toLowerCase().trim() } as never)
    return doc ? toEntity(doc) : null
  }

  async findByGoogleId(googleId: string): Promise<UserEntity | null> {
    const doc = await this.findOne({ googleId } as never)
    return doc ? toEntity(doc) : null
  }

  async upsertGoogleUser(data: {
    googleId: string
    email: string
    nickname: string
    role?: UserRole
  }): Promise<UserEntity> {
    const now = new Date()
    const email = data.email.toLowerCase().trim()
    const existing = await this.findByGoogleId(data.googleId)
    if (existing?._id) return existing

    const byEmail = await this.findByEmail(email)
    if (byEmail?._id) {
      await this.collection.updateOne(
        { _id: new ObjectId(byEmail._id) } as never,
        { $set: { googleId: data.googleId, provider: 'google', nickname: data.nickname, updatedAt: now } },
      )
      return (await this.findByIdSafe(byEmail._id))!
    }

    const id = await this.insertOne({
      email,
      nickname: data.nickname,
      role: data.role ?? 'user',
      googleId: data.googleId,
      provider: 'google',
      permissionsVersion: 1,
      permissionUpdatedAt: now,
      createdAt: now,
      updatedAt: now,
    } as UserDocument)
    return (await this.findByIdSafe(id))!
  }

  async findByIdSafe(id: string): Promise<UserEntity | null> {
    const doc = await this.findById(id)
    return doc ? toEntity(doc) : null
  }

  async createUser(data: {
    email: string
    name: string
    passwordHash: string
    nickname: string
    role?: UserRole
  }): Promise<UserEntity> {
    const now = new Date()
    const id = await this.insertOne({
      email: data.email.toLowerCase().trim(),
      name: data.name.trim(),
      nickname: data.nickname,
      passwordHash: data.passwordHash,
      role: data.role ?? 'user',
      provider: 'local',
      isFirstLogin: true,
      permissionsVersion: 1,
      permissionUpdatedAt: now,
      createdAt: now,
      updatedAt: now,
    } as UserDocument)
    const created = await this.findByIdSafe(id)
    if (!created) throw new Error('Failed to create user')
    return created
  }

  async updateProfile(
    id: string,
    patch: Partial<
      Pick<
        UserEntity,
        'nickname' | 'name' | 'avatar' | 'isFirstLogin' | 'notificationPreferences' | 'shippingAddresses'
      >
    >,
  ): Promise<UserEntity | null> {
    if (!ObjectId.isValid(id)) return null
    await this.collection.updateOne(
      { _id: new ObjectId(id) } as never,
      { $set: { ...patch, updatedAt: new Date() } },
    )
    return this.findByIdSafe(id)
  }

  async countStaff(): Promise<number> {
    return this.count({ isStaff: true } as never)
  }

  async findByIds(ids: string[]): Promise<UserEntity[]> {
    const oids = ids.filter(ObjectId.isValid).map((id) => new ObjectId(id))
    if (!oids.length) return []
    const docs = await this.findMany({ _id: { $in: oids } } as never)
    return docs.map((d) => toEntity(d))
  }

  async listStaff(skip: number, limit: number, search?: string): Promise<{ items: UserEntity[]; total: number }> {
    const filter: Record<string, unknown> = { isStaff: true }
    if (search?.trim()) {
      const rx = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      filter.$or = [{ email: rx }, { name: rx }]
    }
    const [docs, total] = await Promise.all([
      this.collection
        .find(filter as never, { projection: { passwordHash: 0 } })
        .sort({ email: 1 })
        .skip(skip)
        .limit(limit)
        .toArray(),
      this.count(filter as never),
    ])
    return { items: docs.map((d) => toEntity(d)), total }
  }

  async findStaffById(id: string): Promise<UserEntity | null> {
    if (!ObjectId.isValid(id)) return null
    const doc = await this.collection.findOne(
      { _id: new ObjectId(id), isStaff: true } as never,
      { projection: { passwordHash: 0 } },
    )
    return doc ? toEntity(doc) : null
  }

  async updateStaffRole(id: string, role: UserRole): Promise<UserEntity | null> {
    if (!ObjectId.isValid(id)) return null
    const now = new Date()
    const res = await this.collection.updateOne(
      { _id: new ObjectId(id), isStaff: true } as never,
      { $set: { role, permissionsVersion: 1, permissionUpdatedAt: now, updatedAt: now } },
    )
    if (!res.matchedCount) return null
    return this.findStaffById(id)
  }

  async countCreatedBetween(from: Date, to: Date): Promise<number> {
    return this.count({ createdAt: { $gte: from, $lt: to } } as never)
  }

  async listForSecurity(
    skip: number,
    limit: number,
    opts: { staffOnly?: boolean; search?: string },
  ): Promise<{ items: UserEntity[]; total: number }> {
    const filter: Record<string, unknown> = {}
    if (opts.staffOnly) filter.isStaff = true
    if (opts.search?.trim()) {
      const rx = new RegExp(opts.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      filter.$or = [{ email: rx }, { name: rx }, { nickname: rx }]
    }
    const [docs, total] = await Promise.all([
      this.collection
        .find(filter as never, { projection: { passwordHash: 0 } })
        .sort({ email: 1 })
        .skip(skip)
        .limit(limit)
        .toArray(),
      this.count(filter as never),
    ])
    return { items: docs.map((d) => toEntity(d)), total }
  }
}

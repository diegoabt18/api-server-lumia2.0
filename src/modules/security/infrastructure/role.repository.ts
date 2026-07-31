import { ObjectId, type Db } from 'mongodb'
import { BaseRepository, getCollection } from '../../../database/repositories/base.repository.js'
import type { PermissionId } from '../../../common/permissions/registry.js'
import { type RoleEntity, toRoleDomain } from '../domain/role.entity.js'

interface RoleDocument {
  _id: ObjectId
  key: string
  name: string
  description?: string
  permissionKeys: PermissionId[]
  denyKeys?: PermissionId[]
  inheritRoleIds?: string[]
  isSystem?: boolean
  isArchived?: boolean
  archivedAt?: Date | null
  version?: number
  createdAt?: Date
  updatedAt?: Date
}

function toEntity(doc: RoleDocument): RoleEntity {
  return {
    _id: doc._id.toString(),
    key: doc.key,
    name: doc.name,
    description: doc.description,
    permissionKeys: doc.permissionKeys ?? [],
    denyKeys: doc.denyKeys ?? [],
    inheritRoleIds: doc.inheritRoleIds ?? [],
    isSystem: doc.isSystem,
    isArchived: doc.isArchived,
    archivedAt: doc.archivedAt ?? null,
    version: doc.version ?? 1,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  }
}

export class RoleRepository extends BaseRepository<RoleDocument> {
  constructor(db: Db) {
    super(getCollection(db, 'roles'))
  }

  async ensureIndexes(): Promise<void> {
    await super.ensureIndexes([{ key: { key: 1 }, unique: true }])
  }

  async list(includeArchived = false): Promise<RoleEntity[]> {
    const filter = includeArchived ? {} : { $or: [{ isArchived: { $ne: true } }, { isArchived: { $exists: false } }] }
    const docs = await this.findMany(filter as never, { sort: { name: 1 } })
    return docs.map((d) => toEntity(d))
  }

  async findByIdSafe(id: string): Promise<RoleEntity | null> {
    const doc = await this.findById(id)
    return doc ? toEntity(doc) : null
  }

  async findByIds(ids: string[]): Promise<RoleEntity[]> {
    const oids = ids.filter(ObjectId.isValid).map((id) => new ObjectId(id))
    if (!oids.length) return []
    const docs = await this.findMany({ _id: { $in: oids } } as never)
    return docs.map((d) => toEntity(d))
  }

  async findByKey(key: string): Promise<RoleEntity | null> {
    const doc = await this.findOne({ key } as never)
    return doc ? toEntity(doc) : null
  }

  async create(data: {
    key: string
    name: string
    description?: string
    permissionKeys: PermissionId[]
    denyKeys?: PermissionId[]
    inheritRoleIds?: string[]
    isSystem?: boolean
  }): Promise<RoleEntity> {
    const now = new Date()
    const id = await this.insertOne({
      key: data.key.trim(),
      name: data.name.trim(),
      description: data.description?.trim(),
      permissionKeys: data.permissionKeys,
      denyKeys: data.denyKeys ?? [],
      inheritRoleIds: data.inheritRoleIds ?? [],
      isSystem: data.isSystem ?? false,
      isArchived: false,
      archivedAt: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    } as RoleDocument)
    return (await this.findByIdSafe(id))!
  }

  async update(
    id: string,
    patch: Partial<Pick<RoleEntity, 'name' | 'description' | 'permissionKeys' | 'denyKeys' | 'inheritRoleIds'>>,
  ): Promise<RoleEntity | null> {
    if (!ObjectId.isValid(id)) return null
    const existing = await this.findByIdSafe(id)
    if (!existing) return null
    if (existing.isSystem && patch.permissionKeys) {
      throw new Error('SYSTEM_ROLE_IMMUTABLE')
    }
    await this.collection.updateOne(
      { _id: new ObjectId(id) } as never,
      { $set: { ...patch, updatedAt: new Date() }, $inc: { version: 1 } },
    )
    return this.findByIdSafe(id)
  }

  async archive(id: string): Promise<boolean> {
    const existing = await this.findByIdSafe(id)
    if (!existing || existing.isSystem) return false
    const res = await this.collection.updateOne(
      { _id: new ObjectId(id) } as never,
      { $set: { isArchived: true, archivedAt: new Date(), updatedAt: new Date() } },
    )
    return res.modifiedCount > 0
  }

  async restore(id: string): Promise<boolean> {
    const res = await this.collection.updateOne(
      { _id: new ObjectId(id), isArchived: true } as never,
      { $set: { isArchived: false, archivedAt: null, updatedAt: new Date() } },
    )
    return res.modifiedCount > 0
  }

  async duplicate(id: string, newKey: string, newName: string): Promise<RoleEntity | null> {
    const source = await this.findByIdSafe(id)
    if (!source) return null
    return this.create({
      key: newKey,
      name: newName,
      description: source.description,
      permissionKeys: source.permissionKeys,
      denyKeys: source.denyKeys,
      inheritRoleIds: source.inheritRoleIds,
    })
  }

  async delete(id: string): Promise<boolean> {
    const existing = await this.findByIdSafe(id)
    if (!existing || existing.isSystem) return false
    return this.deleteById(id)
  }

  toDomain(entity: RoleEntity) {
    return toRoleDomain(entity)
  }
}

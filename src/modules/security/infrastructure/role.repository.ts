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
  isSystem?: boolean
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
    isSystem: doc.isSystem,
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

  async list(): Promise<RoleEntity[]> {
    const docs = await this.findMany({}, { sort: { name: 1 } })
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
    isSystem?: boolean
  }): Promise<RoleEntity> {
    const now = new Date()
    const id = await this.insertOne({
      key: data.key.trim(),
      name: data.name.trim(),
      description: data.description?.trim(),
      permissionKeys: data.permissionKeys,
      isSystem: data.isSystem ?? false,
      createdAt: now,
      updatedAt: now,
    } as RoleDocument)
    return (await this.findByIdSafe(id))!
  }

  async update(
    id: string,
    patch: Partial<Pick<RoleEntity, 'name' | 'description' | 'permissionKeys'>>,
  ): Promise<RoleEntity | null> {
    if (!ObjectId.isValid(id)) return null
    const existing = await this.findByIdSafe(id)
    if (!existing) return null
    if (existing.isSystem && patch.permissionKeys) {
      throw new Error('SYSTEM_ROLE_IMMUTABLE')
    }
    await this.collection.updateOne(
      { _id: new ObjectId(id) } as never,
      { $set: { ...patch, updatedAt: new Date() } },
    )
    return this.findByIdSafe(id)
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

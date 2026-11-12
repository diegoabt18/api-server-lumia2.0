import { ObjectId, type Db } from 'mongodb'
import { BaseRepository, getCollection } from '../../../database/repositories/base.repository.js'
import type { UserRoleAssignment } from '../domain/role.entity.js'

/** Referencias guardadas como ObjectId, igual que users._id y roles._id. */
interface UserRoleDocument {
  _id: ObjectId
  userId: ObjectId
  roleId: ObjectId
  assignedAt?: Date
  assignedBy?: string | null
}

function toEntity(doc: UserRoleDocument): UserRoleAssignment {
  return {
    _id: doc._id.toString(),
    userId: String(doc.userId),
    roleId: String(doc.roleId),
    assignedAt: doc.assignedAt,
    assignedBy: doc.assignedBy ?? null,
  }
}

/** Convierte un id recibido (string) a ObjectId; null si no es un id válido. */
function toObjectId(id: string): ObjectId | null {
  return ObjectId.isValid(id) ? new ObjectId(id) : null
}

export class UserRoleRepository extends BaseRepository<UserRoleDocument> {
  constructor(db: Db) {
    super(getCollection(db, 'user_roles'))
  }

  async ensureIndexes(): Promise<void> {
    await super.ensureIndexes([
      { key: { userId: 1, roleId: 1 }, unique: true },
      { key: { userId: 1 } },
      { key: { roleId: 1 } },
    ])
  }

  async findByUserId(userId: string): Promise<UserRoleAssignment[]> {
    const uid = toObjectId(userId)
    if (!uid) return []
    const docs = await this.findMany({ userId: uid } as never, { sort: { assignedAt: -1 } })
    return docs.map((d) => toEntity(d))
  }

  async assign(userId: string, roleId: string, assignedBy?: string): Promise<UserRoleAssignment> {
    const now = new Date()
    const uid = toObjectId(userId)
    const rid = toObjectId(roleId)
    if (!uid || !rid) throw new Error(`IDs inválidos para asignar rol: ${userId} / ${roleId}`)
    const existing = await this.findOne({ userId: uid, roleId: rid } as never)
    if (existing) return toEntity(existing)

    const id = await this.insertOne({
      userId: uid,
      roleId: rid,
      assignedAt: now,
      assignedBy: assignedBy ?? null,
    } as UserRoleDocument)
    const doc = await this.findById(id)
    return toEntity(doc!)
  }

  async remove(userId: string, roleId: string): Promise<boolean> {
    const uid = toObjectId(userId)
    const rid = toObjectId(roleId)
    if (!uid || !rid) return false
    const result = await this.collection.deleteOne({ userId: uid, roleId: rid } as never)
    return result.deletedCount > 0
  }

  async removeAllForUser(userId: string): Promise<number> {
    const uid = toObjectId(userId)
    if (!uid) return 0
    const result = await this.collection.deleteMany({ userId: uid } as never)
    return result.deletedCount
  }

  async countAssignmentsForRole(roleId: string): Promise<number> {
    const rid = toObjectId(roleId)
    if (!rid) return 0
    return this.collection.countDocuments({ roleId: rid } as never)
  }
}

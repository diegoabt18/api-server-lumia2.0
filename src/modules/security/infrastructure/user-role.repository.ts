import { ObjectId, type Db } from 'mongodb'
import { BaseRepository, getCollection } from '../../../database/repositories/base.repository.js'
import type { UserRoleAssignment } from '../domain/role.entity.js'

interface UserRoleDocument {
  _id: ObjectId
  userId: string
  roleId: string
  assignedAt?: Date
  assignedBy?: string | null
}

function toEntity(doc: UserRoleDocument): UserRoleAssignment {
  return {
    _id: doc._id.toString(),
    userId: doc.userId,
    roleId: doc.roleId,
    assignedAt: doc.assignedAt,
    assignedBy: doc.assignedBy ?? null,
  }
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
    const docs = await this.findMany({ userId } as never, { sort: { assignedAt: -1 } })
    return docs.map((d) => toEntity(d))
  }

  async assign(userId: string, roleId: string, assignedBy?: string): Promise<UserRoleAssignment> {
    const now = new Date()
    const existing = await this.findOne({ userId, roleId } as never)
    if (existing) return toEntity(existing)

    const id = await this.insertOne({
      userId,
      roleId,
      assignedAt: now,
      assignedBy: assignedBy ?? null,
    } as UserRoleDocument)
    const doc = await this.findById(id)
    return toEntity(doc!)
  }

  async remove(userId: string, roleId: string): Promise<boolean> {
    const result = await this.collection.deleteOne({ userId, roleId } as never)
    return result.deletedCount > 0
  }

  async removeAllForUser(userId: string): Promise<number> {
    const result = await this.collection.deleteMany({ userId } as never)
    return result.deletedCount
  }

  async countAssignmentsForRole(roleId: string): Promise<number> {
    return this.collection.countDocuments({ roleId } as never)
  }
}

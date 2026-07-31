import { ObjectId, type Db } from 'mongodb'
import { BaseRepository, getCollection } from '../../../database/repositories/base.repository.js'
import { buildPaginationMeta } from '../../../common/utils/pagination.js'

export interface NotificationEntity {
  _id?: string
  userId: string
  type: string
  title: string
  message: string
  read: boolean
  createdAt: Date
  data?: Record<string, string>
}

interface NotificationDocument extends Omit<NotificationEntity, '_id'> {
  _id: ObjectId
}

function toEntity(doc: NotificationDocument): NotificationEntity {
  return { ...doc, _id: doc._id.toString() }
}

function toDto(doc: NotificationEntity) {
  return {
    id: doc._id!,
    type: doc.type,
    title: doc.title,
    message: doc.message,
    read: doc.read,
    createdAt: doc.createdAt.toISOString(),
    ...(doc.data && Object.keys(doc.data).length ? { data: doc.data } : {}),
  }
}

export class NotificationRepository extends BaseRepository<NotificationDocument> {
  constructor(db: Db) {
    super(getCollection(db, 'notifications'))
  }

  async ensureIndexes(): Promise<void> {
    await super.ensureIndexes([
      { key: { userId: 1, createdAt: -1 }, name: 'notifications_user_createdAt' },
      { key: { userId: 1, read: 1 }, name: 'notifications_user_read' },
    ])
  }

  async listByUser(userId: string, page: number, limit: number) {
    const skip = (page - 1) * limit
    const [docs, total] = await Promise.all([
      this.findMany({ userId } as never, { skip, limit, sort: { createdAt: -1 } }),
      this.count({ userId } as never),
    ])
    return {
      items: docs.map((d) => toDto(toEntity(d))),
      total,
      pagination: buildPaginationMeta(total, page, limit),
    }
  }

  async countUnread(userId: string): Promise<number> {
    return this.count({ userId, read: false } as never)
  }

  async markRead(userId: string, ids: string[]): Promise<number> {
    const oids = ids.filter(ObjectId.isValid).map((id) => new ObjectId(id))
    if (!oids.length) return 0
    const res = await this.collection.updateMany(
      { userId, _id: { $in: oids } } as never,
      { $set: { read: true } },
    )
    return res.modifiedCount
  }

  async markAllRead(userId: string): Promise<number> {
    const res = await this.collection.updateMany(
      { userId, read: false } as never,
      { $set: { read: true } },
    )
    return res.modifiedCount
  }

  async deleteOne(userId: string, id: string): Promise<boolean> {
    if (!ObjectId.isValid(id)) return false
    const res = await this.collection.deleteOne({ userId, _id: new ObjectId(id) } as never)
    return res.deletedCount === 1
  }
}

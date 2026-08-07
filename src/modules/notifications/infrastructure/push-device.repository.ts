import { ObjectId, type Db } from 'mongodb'
import { BaseRepository, getCollection } from '../../../database/repositories/base.repository.js'

export interface PushDeviceEntity {
  _id?: string
  fcmToken: string
  platform: 'android' | 'ios'
  deviceLabel?: string
  active: boolean
  createdAt: Date
  updatedAt: Date
  lastSeenAt: Date
}

interface PushDeviceDocument extends Omit<PushDeviceEntity, '_id'> {
  _id: ObjectId
}

export class PushDeviceRepository extends BaseRepository<PushDeviceDocument> {
  constructor(db: Db) {
    super(getCollection(db, 'push_devices'))
  }

  async ensureIndexes(): Promise<void> {
    await super.ensureIndexes([
      { key: { fcmToken: 1 }, name: 'push_devices_fcmToken', unique: true },
      { key: { active: 1, updatedAt: -1 }, name: 'push_devices_active_updatedAt' },
    ])
  }

  async upsertDevice(input: {
    fcmToken: string
    platform: 'android' | 'ios'
    deviceLabel?: string
  }): Promise<void> {
    const now = new Date()
    await this.collection.updateOne(
      { fcmToken: input.fcmToken } as never,
      {
        $set: {
          platform: input.platform,
          deviceLabel: input.deviceLabel,
          active: true,
          updatedAt: now,
          lastSeenAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true },
    )
  }

  async deactivateToken(fcmToken: string): Promise<boolean> {
    const res = await this.collection.updateOne(
      { fcmToken } as never,
      { $set: { active: false, updatedAt: new Date() } },
    )
    return res.matchedCount > 0
  }

  async listActiveTokens(): Promise<string[]> {
    const docs = await this.findMany({ active: true } as never, { limit: 500 })
    return docs.map((d) => d.fcmToken)
  }

  async deactivateTokens(tokens: string[]): Promise<number> {
    if (!tokens.length) return 0
    const res = await this.collection.updateMany(
      { fcmToken: { $in: tokens } } as never,
      { $set: { active: false, updatedAt: new Date() } },
    )
    return res.modifiedCount
  }
}

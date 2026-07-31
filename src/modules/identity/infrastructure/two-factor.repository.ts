import { ObjectId, type Db } from 'mongodb'
import { getCollection } from '../../../database/repositories/base.repository.js'
import type { UserTwoFactor } from '../domain/user.entity.js'

interface TwoFactorDocument {
  twoFactor?: UserTwoFactor
}

export class TwoFactorRepository {
  constructor(private readonly db: Db) {}

  private collection() {
    return getCollection<TwoFactorDocument & { _id: ObjectId }>(this.db, 'users')
  }

  async getTwoFactor(userId: string): Promise<UserTwoFactor | null> {
    if (!ObjectId.isValid(userId)) return null
    const doc = await this.collection().findOne(
      { _id: new ObjectId(userId) },
      { projection: { twoFactor: 1 } },
    )
    return doc?.twoFactor ?? null
  }

  async setPendingSecret(userId: string, pendingSecretEnc: string): Promise<void> {
    if (!ObjectId.isValid(userId)) return
    const now = new Date()
    await this.collection().updateOne(
      { _id: new ObjectId(userId) },
      {
        $set: {
          'twoFactor.pendingSecretEnc': pendingSecretEnc,
          'twoFactor.enabled': false,
          updatedAt: now,
        },
      },
    )
  }

  async confirmSetup(userId: string, secretEnc: string): Promise<void> {
    if (!ObjectId.isValid(userId)) return
    const now = new Date()
    await this.collection().updateOne(
      { _id: new ObjectId(userId) },
      {
        $set: {
          'twoFactor.enabled': true,
          'twoFactor.secretEnc': secretEnc,
          'twoFactor.confirmedAt': now,
          updatedAt: now,
        },
        $unset: { 'twoFactor.pendingSecretEnc': '' },
      },
    )
  }

  async disable(userId: string): Promise<void> {
    if (!ObjectId.isValid(userId)) return
    await this.collection().updateOne(
      { _id: new ObjectId(userId) },
      { $unset: { twoFactor: '' }, $set: { updatedAt: new Date() } },
    )
  }

  async getPendingSecretEnc(userId: string): Promise<string | null> {
    const tf = await this.getTwoFactor(userId)
    return tf?.pendingSecretEnc ?? null
  }

  async getSecretEnc(userId: string): Promise<string | null> {
    const tf = await this.getTwoFactor(userId)
    if (!tf?.enabled || !tf.secretEnc) return null
    return tf.secretEnc
  }

  async getStatus(userId: string): Promise<{
    enabled: boolean
    confirmedAt?: string | null
    remainingBackupCodes?: number
  } | null> {
    const tf = await this.getTwoFactor(userId)
    if (!tf) return { enabled: false, confirmedAt: null, remainingBackupCodes: 0 }
    return {
      enabled: !!tf.enabled,
      confirmedAt: tf.confirmedAt?.toISOString?.() ?? null,
      remainingBackupCodes: tf.remainingBackupCodes ?? tf.backupCodesHashed?.length ?? 0,
    }
  }

  async updateBackupCodes(userId: string, hashedCodes: string[], remaining: number): Promise<void> {
    if (!ObjectId.isValid(userId)) return
    await this.collection().updateOne(
      { _id: new ObjectId(userId) },
      {
        $set: {
          'twoFactor.backupCodesHashed': hashedCodes,
          'twoFactor.remainingBackupCodes': remaining,
          updatedAt: new Date(),
        },
      },
    )
  }

  async findUserIdsWith2faEnabled(limit = 100): Promise<string[]> {
    const docs = await this.collection()
      .find({ 'twoFactor.enabled': true }, { projection: { _id: 1 }, limit })
      .toArray()
    return docs.map((d) => d._id.toString())
  }
}

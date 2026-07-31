import type { Db } from 'mongodb'
import { ObjectId } from 'mongodb'
import { getCollection } from '../../../database/repositories/base.repository.js'
import { buildPaginationMeta } from '../../../common/utils/pagination.js'

export class FeedbackReportRepository {
  private readonly collection

  constructor(db: Db) {
    this.collection = getCollection(db, 'feedback_reports')
  }

  async listAdmin(skip: number, limit: number) {
    const [items, total] = await Promise.all([
      this.collection.find({}).sort({ created_at: -1 }).skip(skip).limit(limit).toArray(),
      this.collection.countDocuments({}),
    ])
    return {
      items: items.map((x) => ({
        id: String(x._id),
        entityType: (x as { entity_type?: string }).entity_type,
        entityId: (x as { entity_id?: string }).entity_id,
        userId: (x as { user_id?: string }).user_id,
        reason: (x as { reason?: string }).reason,
        status: (x as { status?: string }).status ?? 'pending',
        createdAt: (x as { created_at?: Date }).created_at,
      })),
      total,
    }
  }

  async patchQuestion(id: string, patch: { hidden?: boolean; answered?: boolean }): Promise<boolean> {
    if (!ObjectId.isValid(id)) return false
    const col = this.collection.db.collection('product_questions')
    const res = await col.updateOne({ _id: new ObjectId(id) }, { $set: { ...patch, updated_at: new Date() } })
    return res.matchedCount > 0
  }
}

export { buildPaginationMeta }

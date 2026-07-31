import type { Db, Filter } from 'mongodb'
import { ObjectId } from 'mongodb'
import { BaseRepository, getCollection } from '../../../database/repositories/base.repository.js'
import {
  toPriceApprovalDomain,
  type ApprovalStatus,
  type PriceApprovalDomain,
  type PriceApprovalEntity,
} from '../domain/price-approval.entity.js'

export class PriceApprovalRepository extends BaseRepository<PriceApprovalEntity> {
  constructor(db: Db) {
    super(getCollection<PriceApprovalEntity>(db, 'price_approvals'))
  }

  async ensureIndexes(): Promise<void> {
    await super.ensureIndexes([
      { key: { status: 1, created_at: -1 } },
      { key: { variant_sku: 1 } },
    ])
  }

  async list(options: {
    status?: ApprovalStatus
    limit: number
    offset: number
  }): Promise<{ items: PriceApprovalDomain[]; total: number }> {
    const filter: Filter<PriceApprovalEntity> = options.status
      ? ({ status: options.status } as Filter<PriceApprovalEntity>)
      : {}
    const [docs, total] = await Promise.all([
      this.findMany(filter, { skip: options.offset, limit: options.limit, sort: { created_at: -1 } }),
      this.count(filter),
    ])
    return { items: docs.map(toPriceApprovalDomain), total }
  }

  async getById(id: string): Promise<PriceApprovalDomain | null> {
    const doc = await this.findById(id)
    return doc ? toPriceApprovalDomain(doc) : null
  }

  async update(id: string, patch: Partial<PriceApprovalEntity>): Promise<PriceApprovalDomain | null> {
    if (!ObjectId.isValid(id)) return null
    await this.collection.updateOne({ _id: new ObjectId(id) } as Filter<PriceApprovalEntity>, {
      $set: { ...patch, updated_at: new Date() },
    })
    return this.getById(id)
  }

  async countByStatus(status: ApprovalStatus): Promise<number> {
    return this.count({ status } as Filter<PriceApprovalEntity>)
  }
}

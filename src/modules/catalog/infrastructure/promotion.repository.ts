import type { Db } from 'mongodb'
import { ObjectId } from 'mongodb'
import { BaseRepository, getCollection } from '../../../database/repositories/base.repository.js'
import type { PromotionEntity } from '../domain/promotion.entity.js'

export type PromotionAdminListFilters = {
  search?: string
  lifecycle?: 'pendiente' | 'activa' | 'finalizada' | 'all'
  activeOnly?: boolean
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function buildAdminFilter(now: Date, filters: PromotionAdminListFilters): Record<string, unknown> {
  const parts: Record<string, unknown>[] = []
  if (filters.search?.trim()) {
    const term = escapeRegex(filters.search.trim())
    parts.push({
      $or: [{ name: { $regex: term, $options: 'i' } }, { description: { $regex: term, $options: 'i' } }],
    })
  }
  if (filters.activeOnly) parts.push({ active: true })
  const lc = filters.lifecycle
  if (lc && lc !== 'all') {
    if (lc === 'pendiente') parts.push({ active: true, starts_at: { $gt: now } })
    else if (lc === 'activa') parts.push({ active: true, starts_at: { $lte: now }, ends_at: { $gte: now } })
    else if (lc === 'finalizada') parts.push({ $or: [{ ends_at: { $lt: now } }, { active: false }] })
  }
  if (parts.length === 0) return {}
  if (parts.length === 1) return parts[0]!
  return { $and: parts }
}

export class PromotionRepository extends BaseRepository<PromotionEntity> {
  constructor(db: Db) {
    super(getCollection(db, 'promotions'))
  }

  async ensureIndexes(): Promise<void> {
    await super.ensureIndexes([
      { key: { active: 1, starts_at: 1, ends_at: 1 } },
      { key: { priority: 1 } },
    ])
  }

  async findActiveAt(at: Date): Promise<PromotionEntity[]> {
    return this.findMany(
      {
        active: true,
        starts_at: { $lte: at },
        ends_at: { $gte: at },
      } as never,
      { sort: { priority: 1 } },
    )
  }

  async countActiveAt(at: Date): Promise<number> {
    return this.count({
      active: true,
      starts_at: { $lte: at },
      ends_at: { $gte: at },
    } as never)
  }

  async findExpiringSoon(now: Date, until: Date, limit: number) {
    return this.findMany(
      { active: true, ends_at: { $gte: now, $lte: until } } as never,
      { sort: { ends_at: 1 }, limit },
    )
  }

  async countAdmin(filters: PromotionAdminListFilters, now: Date): Promise<number> {
    return this.count(buildAdminFilter(now, filters) as never)
  }

  async listAdmin(
    skip: number,
    limit: number,
    filters: PromotionAdminListFilters,
    now: Date,
  ): Promise<PromotionEntity[]> {
    return this.findMany(buildAdminFilter(now, filters) as never, {
      skip,
      limit,
      sort: { starts_at: -1 },
    })
  }

  async findByIdSafe(id: string): Promise<PromotionEntity | null> {
    if (!ObjectId.isValid(id)) return null
    return this.findOne({ _id: new ObjectId(id) } as never)
  }

  async listOverlappingActiveWindow(startsAt: Date, endsAt: Date, excludeId?: string): Promise<PromotionEntity[]> {
    const q: Record<string, unknown> = {
      active: true,
      starts_at: { $lte: endsAt },
      ends_at: { $gte: startsAt },
    }
    if (excludeId && ObjectId.isValid(excludeId)) q._id = { $ne: new ObjectId(excludeId) }
    return this.findMany(q as never)
  }

  async replaceById(id: string, doc: Omit<PromotionEntity, '_id'>): Promise<boolean> {
    if (!ObjectId.isValid(id)) return false
    const full = { ...doc, _id: new ObjectId(id) } as PromotionEntity
    const r = await this.collection.replaceOne({ _id: new ObjectId(id) } as never, full as never)
    return r.matchedCount > 0
  }

  async patchActive(id: string, active: boolean): Promise<boolean> {
    return this.updateById(id, { $set: { active, updated_at: new Date() } })
  }
}

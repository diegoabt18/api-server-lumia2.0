import type { Db, Filter } from 'mongodb'
import { ObjectId } from 'mongodb'
import { BaseRepository, getCollection } from '../../../database/repositories/base.repository.js'
import { DEFAULT_UNITS, toUnitDomain, type UnitDomain, type UnitEntity } from '../domain/unit.entity.js'

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export class UnitRepository extends BaseRepository<UnitEntity> {
  private seeded = false

  constructor(db: Db) {
    super(getCollection<UnitEntity>(db, 'unit_of_measures'))
  }

  async ensureIndexes(): Promise<void> {
    await super.ensureIndexes([
      { key: { abbreviation: 1 }, unique: true },
      { key: { family: 1, sort_order: 1 } },
    ])
    await this.ensureDefaults()
  }

  async ensureDefaults(): Promise<void> {
    if (this.seeded) return
    const count = await this.count()
    if (count === 0) {
      const now = new Date()
      await this.collection.insertMany(
        DEFAULT_UNITS.map((u) => ({ ...u, created_at: now, updated_at: now })) as never[],
      )
    }
    this.seeded = true
  }

  async list(search?: string, family?: string): Promise<UnitDomain[]> {
    await this.ensureDefaults()
    const filter = this.buildFilter(search, family)
    const docs = await this.findMany(filter, { sort: { sort_order: 1 } })
    return docs.map(toUnitDomain)
  }

  async getById(id: string): Promise<UnitDomain | null> {
    await this.ensureDefaults()
    let doc = await this.findById(id)
    if (!doc) doc = await this.findOne({ abbreviation: id } as Filter<UnitEntity>)
    return doc ? toUnitDomain(doc) : null
  }

  async getByAbbreviation(abbreviation: string): Promise<UnitDomain | null> {
    await this.ensureDefaults()
    const doc = await this.findOne({ abbreviation } as Filter<UnitEntity>)
    return doc ? toUnitDomain(doc) : null
  }

  async create(input: {
    name: string
    abbreviation: string
    family: UnitEntity['family']
    baseFactor: number
    active?: boolean
    sortOrder?: number
  }): Promise<UnitDomain> {
    const now = new Date()
    const entity: Omit<UnitEntity, '_id'> = {
      name: input.name.trim(),
      abbreviation: input.abbreviation.trim(),
      family: input.family,
      base_factor: input.baseFactor,
      active: input.active ?? true,
      sort_order: input.sortOrder ?? 0,
      created_at: now,
      updated_at: now,
    }
    const id = await this.insertOne(entity as never)
    const doc = await this.findById(id)
    if (!doc) throw new Error('Failed to create unit')
    return toUnitDomain(doc)
  }

  async update(id: string, patch: Record<string, unknown>): Promise<UnitDomain | null> {
    if (!ObjectId.isValid(id)) return null
    const $set: Record<string, unknown> = { updated_at: new Date() }
    if (patch.name !== undefined) $set.name = patch.name
    if (patch.abbreviation !== undefined) $set.abbreviation = patch.abbreviation
    if (patch.family !== undefined) $set.family = patch.family
    if (patch.baseFactor !== undefined) $set.base_factor = patch.baseFactor
    if (patch.active !== undefined) $set.active = patch.active
    if (patch.sortOrder !== undefined) $set.sort_order = patch.sortOrder

    await this.collection.updateOne({ _id: new ObjectId(id) } as Filter<UnitEntity>, { $set })
    return this.getById(id)
  }

  async deleteUnit(id: string): Promise<boolean> {
    return this.deleteById(id)
  }

  private buildFilter(search?: string, family?: string): Filter<UnitEntity> {
    const parts: Filter<UnitEntity>[] = []
    if (search?.trim()) {
      const term = escapeRegex(search.trim())
      parts.push({
        $or: [
          { name: { $regex: term, $options: 'i' } },
          { abbreviation: { $regex: term, $options: 'i' } },
        ],
      } as Filter<UnitEntity>)
    }
    if (family) parts.push({ family } as Filter<UnitEntity>)
    if (!parts.length) return {}
    if (parts.length === 1) return parts[0]!
    return { $and: parts } as Filter<UnitEntity>
  }
}

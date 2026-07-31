import type { Db, Filter } from 'mongodb'
import { ObjectId } from 'mongodb'
import { BaseRepository, getCollection } from '../../../database/repositories/base.repository.js'
import { toUnitEquivalenceDomain, type UnitEquivalenceDomain, type UnitEquivalenceEntity } from '../domain/unit-equivalence.entity.js'
import type { UnitEntity } from '../domain/unit.entity.js'

export interface UnitConversionConfig {
  definitions: {
    id: string
    name: string
    abbreviation: string
    family: string
    baseFactor: number
    active: boolean
    sortOrder: number
  }[]
  equivalences: { fromUnitId: string; toUnitId: string; factor: number }[]
}

export class UnitEquivalenceRepository extends BaseRepository<UnitEquivalenceEntity> {
  private readonly unitsCollection

  constructor(db: Db) {
    super(getCollection<UnitEquivalenceEntity>(db, 'unit_equivalences'))
    this.unitsCollection = getCollection<UnitEntity>(db, 'unit_of_measures')
  }

  async ensureIndexes(): Promise<void> {
    await super.ensureIndexes([
      { key: { from_unit_id: 1, to_unit_id: 1 }, unique: true },
      { key: { active: 1 }, name: 'equiv_active' },
    ])
  }

  async list(activeOnly?: boolean): Promise<UnitEquivalenceDomain[]> {
    const filter: Filter<UnitEquivalenceEntity> = activeOnly ? ({ active: true } as Filter<UnitEquivalenceEntity>) : {}
    const docs = await this.findMany(filter, { sort: { created_at: -1 } })
    return docs.map(toUnitEquivalenceDomain)
  }

  async getById(id: string): Promise<UnitEquivalenceDomain | null> {
    const doc = await this.findById(id)
    return doc ? toUnitEquivalenceDomain(doc) : null
  }

  async create(input: {
    fromUnitId: string
    toUnitId: string
    factor: number
    description?: string
    active?: boolean
  }): Promise<UnitEquivalenceDomain> {
    const now = new Date()
    const entity: Omit<UnitEquivalenceEntity, '_id'> = {
      from_unit_id: input.fromUnitId,
      to_unit_id: input.toUnitId,
      factor: input.factor,
      description: input.description ?? '',
      active: input.active ?? true,
      created_at: now,
      updated_at: now,
    }
    const id = await this.insertOne(entity as never)
    const doc = await this.findById(id)
    if (!doc) throw new Error('Failed to create equivalence')
    return toUnitEquivalenceDomain(doc)
  }

  async update(id: string, patch: Record<string, unknown>): Promise<UnitEquivalenceDomain | null> {
    if (!ObjectId.isValid(id)) return null
    const $set: Record<string, unknown> = { updated_at: new Date() }
    if (patch.fromUnitId !== undefined) $set.from_unit_id = patch.fromUnitId
    if (patch.toUnitId !== undefined) $set.to_unit_id = patch.toUnitId
    if (patch.factor !== undefined) $set.factor = patch.factor
    if (patch.description !== undefined) $set.description = patch.description
    if (patch.active !== undefined) $set.active = patch.active
    await this.collection.updateOne({ _id: new ObjectId(id) } as Filter<UnitEquivalenceEntity>, { $set })
    return this.getById(id)
  }

  async deleteEquivalence(id: string): Promise<boolean> {
    return this.deleteById(id)
  }

  async getConversionConfig(): Promise<UnitConversionConfig> {
    const [unitDocs, equivDocs] = await Promise.all([
      this.unitsCollection.find({ active: true }).sort({ sort_order: 1 }).toArray(),
      this.findMany({ active: true } as Filter<UnitEquivalenceEntity>),
    ])
    return {
      definitions: unitDocs.map((d) => ({
        id: d._id?.toString?.() ?? '',
        name: d.name,
        abbreviation: d.abbreviation,
        family: d.family,
        baseFactor: d.base_factor,
        active: d.active ?? true,
        sortOrder: d.sort_order ?? 0,
      })),
      equivalences: equivDocs.map((e) => ({
        fromUnitId: e.from_unit_id,
        toUnitId: e.to_unit_id,
        factor: e.factor,
      })),
    }
  }
}

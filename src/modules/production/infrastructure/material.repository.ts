import type { Db, Filter } from 'mongodb'
import { ObjectId } from 'mongodb'
import { BaseRepository, getCollection } from '../../../database/repositories/base.repository.js'
import {
  toMaterialDomain,
  toMaterialEntity,
  type MaterialDomain,
  type MaterialEntity,
} from '../domain/material.entity.js'
import { toMaterialPriceDomain, type MaterialPriceEntity } from '../domain/material-price.entity.js'

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function buildMaterialFilter(search?: string, category?: string, activeOnly?: boolean): Filter<MaterialEntity> {
  const parts: Filter<MaterialEntity>[] = []
  if (search?.trim()) {
    const term = escapeRegex(search.trim())
    parts.push({
      $or: [{ name: { $regex: term, $options: 'i' } }, { code: { $regex: term, $options: 'i' } }],
    } as Filter<MaterialEntity>)
  }
  if (category) parts.push({ category } as Filter<MaterialEntity>)
  if (activeOnly) parts.push({ active: true } as Filter<MaterialEntity>)
  if (!parts.length) return {}
  if (parts.length === 1) return parts[0]!
  return { $and: parts } as Filter<MaterialEntity>
}

export class MaterialRepository extends BaseRepository<MaterialEntity> {
  private readonly priceHistory: ReturnType<typeof getCollection<MaterialPriceEntity>>

  constructor(db: Db) {
    super(getCollection<MaterialEntity>(db, 'materials'))
    this.priceHistory = getCollection<MaterialPriceEntity>(db, 'material_price_history')
  }

  async ensureIndexes(): Promise<void> {
    await super.ensureIndexes([
      { key: { name: 1 } },
      { key: { category: 1, active: 1 } },
    ])
    await this.priceHistory.createIndexes([
      { key: { material_id: 1, recorded_at: -1 } },
    ])
  }

  async countAll(search?: string, category?: string, activeOnly?: boolean): Promise<number> {
    return this.count(buildMaterialFilter(search, category, activeOnly))
  }

  async list(
    limit: number,
    offset: number,
    search?: string,
    category?: string,
    activeOnly?: boolean,
  ): Promise<MaterialDomain[]> {
    const docs = await this.findMany(buildMaterialFilter(search, category, activeOnly), {
      skip: offset,
      limit,
      sort: { name: 1 },
    })
    return docs.map(toMaterialDomain)
  }

  async getById(id: string): Promise<MaterialDomain | null> {
    const doc = await this.findById(id)
    return doc ? toMaterialDomain(doc) : null
  }

  async getByName(name: string): Promise<MaterialDomain | null> {
    const doc = await this.findOne({ name: name.trim() } as Filter<MaterialEntity>)
    return doc ? toMaterialDomain(doc) : null
  }

  async getByIds(ids: string[]): Promise<MaterialDomain[]> {
    const oids = ids.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id))
    if (!oids.length) return []
    const docs = await this.findMany({ _id: { $in: oids } } as Filter<MaterialEntity>)
    return docs.map(toMaterialDomain)
  }

  async create(input: Parameters<typeof toMaterialEntity>[0]): Promise<MaterialDomain> {
    const entity = toMaterialEntity(input)
    const id = await this.insertOne(entity as never)
    const doc = await this.findById(id)
    if (!doc) throw new Error('Failed to create material')
    return toMaterialDomain(doc)
  }

  async update(id: string, patch: Record<string, unknown>): Promise<MaterialDomain | null> {
    if (!ObjectId.isValid(id)) return null
    const $set: Record<string, unknown> = { updated_at: new Date() }
    const $unset: Record<string, ''> = {}

    if (patch.name !== undefined) $set.name = patch.name
    if (patch.code !== undefined) {
      if (patch.code === null || patch.code === '') $unset.code = ''
      else $set.code = patch.code
    }
    if (patch.category !== undefined) $set.category = patch.category
    if (patch.description !== undefined) {
      if (patch.description === null || patch.description === '') $unset.description = ''
      else $set.description = patch.description
    }
    if (patch.imagePath !== undefined) {
      if (patch.imagePath === null || patch.imagePath === '') $unset.image_path = ''
      else $set.image_path = patch.imagePath
    }
    if (patch.active !== undefined) $set.active = patch.active
    if (patch.purchaseUnit !== undefined) $set.purchase_unit = patch.purchaseUnit
    if (patch.rollMeters !== undefined) {
      if (patch.rollMeters === null) $unset.roll_meters = ''
      else $set.roll_meters = patch.rollMeters
    }
    if (patch.stockEnabled !== undefined) $set.stock_enabled = patch.stockEnabled
    if (patch.stockCurrent !== undefined) {
      if (patch.stockCurrent === null) $unset.stock_current = ''
      else $set.stock_current = patch.stockCurrent
    }
    if (patch.stockMinimum !== undefined) {
      if (patch.stockMinimum === null) $unset.stock_minimum = ''
      else $set.stock_minimum = patch.stockMinimum
    }
    if (patch.stockUnit !== undefined) {
      if (patch.stockUnit === null || patch.stockUnit === '') $unset.stock_unit = ''
      else $set.stock_unit = patch.stockUnit
    }

    const updateDoc: Record<string, unknown> = { $set }
    if (Object.keys($unset).length) updateDoc.$unset = $unset
    await this.collection.updateOne({ _id: new ObjectId(id) } as Filter<MaterialEntity>, updateDoc)
    return this.getById(id)
  }

  async updateLastCost(id: string, lastCost: number, lastCostUnit: string, rollMeters?: number): Promise<void> {
    const $set: Record<string, unknown> = {
      last_cost: lastCost,
      last_cost_unit: lastCostUnit,
      updated_at: new Date(),
    }
    if (rollMeters !== undefined) $set.roll_meters = rollMeters
    await this.collection.updateOne({ _id: new ObjectId(id) } as Filter<MaterialEntity>, { $set })
  }

  async deleteMaterial(id: string): Promise<boolean> {
    return this.deleteById(id)
  }

  async listPriceHistory(materialId: string): Promise<ReturnType<typeof toMaterialPriceDomain>[]> {
    if (!ObjectId.isValid(materialId)) return []
    const docs = await this.priceHistory
      .find({ material_id: new ObjectId(materialId) } as Filter<MaterialPriceEntity>)
      .sort({ recorded_at: -1 })
      .toArray()
    return docs.map(toMaterialPriceDomain)
  }

  async createPriceEntry(entry: Omit<MaterialPriceEntity, '_id'>): Promise<ReturnType<typeof toMaterialPriceDomain>> {
    const result = await this.priceHistory.insertOne(entry as never)
    const doc = await this.priceHistory.findOne({ _id: result.insertedId } as Filter<MaterialPriceEntity>)
    if (!doc) throw new Error('Failed to create price entry')
    return toMaterialPriceDomain(doc)
  }
}

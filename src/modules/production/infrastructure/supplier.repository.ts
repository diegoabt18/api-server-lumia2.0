import type { Db, Filter } from 'mongodb'
import { ObjectId } from 'mongodb'
import { BaseRepository, getCollection } from '../../../database/repositories/base.repository.js'
import {
  toSupplierDomain,
  toSupplierEntity,
  type SupplierDomain,
  type SupplierEntity,
} from '../domain/supplier.entity.js'

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export class SupplierRepository extends BaseRepository<SupplierEntity> {
  constructor(db: Db) {
    super(getCollection<SupplierEntity>(db, 'suppliers'))
  }

  async ensureIndexes(): Promise<void> {
    await super.ensureIndexes([{ key: { name: 1 } }])
  }

  async countAll(search?: string, activeOnly?: boolean): Promise<number> {
    return this.count(this.buildFilter(search, activeOnly))
  }

  async list(limit: number, offset: number, search?: string, activeOnly?: boolean): Promise<SupplierDomain[]> {
    const docs = await this.findMany(this.buildFilter(search, activeOnly), {
      skip: offset,
      limit,
      sort: { name: 1 },
    })
    return docs.map(toSupplierDomain)
  }

  async getById(id: string): Promise<SupplierDomain | null> {
    const doc = await this.findById(id)
    return doc ? toSupplierDomain(doc) : null
  }

  async create(input: Parameters<typeof toSupplierEntity>[0]): Promise<SupplierDomain> {
    const entity = toSupplierEntity(input)
    const id = await this.insertOne(entity as never)
    const doc = await this.findById(id)
    if (!doc) throw new Error('Failed to create supplier')
    return toSupplierDomain(doc)
  }

  async update(id: string, patch: Record<string, unknown>): Promise<SupplierDomain | null> {
    if (!ObjectId.isValid(id)) return null
    const $set: Record<string, unknown> = { updated_at: new Date() }
    const $unset: Record<string, ''> = {}

    if (patch.name !== undefined) $set.name = patch.name
    if (patch.contactName !== undefined) {
      if (patch.contactName === null) $unset.contact_name = ''
      else $set.contact_name = patch.contactName
    }
    if (patch.phone !== undefined) {
      if (patch.phone === null) $unset.phone = ''
      else $set.phone = patch.phone
    }
    if (patch.email !== undefined) {
      if (patch.email === null || patch.email === '') $unset.email = ''
      else $set.email = patch.email
    }
    if (patch.notes !== undefined) {
      if (patch.notes === null) $unset.notes = ''
      else $set.notes = patch.notes
    }
    if (patch.isFavorite !== undefined) $set.is_favorite = patch.isFavorite
    if (patch.active !== undefined) $set.active = patch.active

    const updateDoc: Record<string, unknown> = { $set }
    if (Object.keys($unset).length) updateDoc.$unset = $unset
    await this.collection.updateOne({ _id: new ObjectId(id) } as Filter<SupplierEntity>, updateDoc)
    return this.getById(id)
  }

  async deleteSupplier(id: string): Promise<boolean> {
    return this.deleteById(id)
  }

  private buildFilter(search?: string, activeOnly?: boolean): Filter<SupplierEntity> {
    const parts: Filter<SupplierEntity>[] = []
    if (search?.trim()) {
      const term = escapeRegex(search.trim())
      parts.push({
        $or: [
          { name: { $regex: term, $options: 'i' } },
          { contact_name: { $regex: term, $options: 'i' } },
        ],
      } as Filter<SupplierEntity>)
    }
    if (activeOnly) parts.push({ active: true } as Filter<SupplierEntity>)
    if (!parts.length) return {}
    if (parts.length === 1) return parts[0]!
    return { $and: parts } as Filter<SupplierEntity>
  }
}

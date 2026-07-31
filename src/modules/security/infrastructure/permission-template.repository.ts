import { ObjectId, type Db, type Document, type Filter } from 'mongodb'
import { expandPermissions } from '../../../common/permissions/registry.js'
import { BaseRepository, getCollection } from '../../../database/repositories/base.repository.js'
import type { PermissionTemplateEntity, TemplateStatus } from '../domain/enterprise.entities.js'

interface TemplateDocument extends Document {
  name: string
  description: string
  permissionKeys: string[]
  category?: string | null
  color?: string | null
  icon?: string | null
  metadata?: Record<string, unknown>
  version: number
  status: TemplateStatus
  createdBy: string
  updatedBy: string
  createdAt: Date
  updatedAt: Date
  archivedAt?: Date | null
}

function toEntity(doc: TemplateDocument & { _id: ObjectId }): PermissionTemplateEntity {
  return {
    _id: doc._id.toString(),
    name: doc.name,
    description: doc.description ?? '',
    permissionKeys: expandPermissions(doc.permissionKeys ?? []),
    category: doc.category ?? null,
    color: doc.color ?? null,
    icon: doc.icon ?? null,
    metadata: doc.metadata ?? {},
    version: doc.version ?? 1,
    status: doc.status ?? 'active',
    createdBy: doc.createdBy,
    updatedBy: doc.updatedBy,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    archivedAt: doc.archivedAt ?? null,
  }
}

export interface TemplateListFilters {
  page?: number
  limit?: number
  search?: string
  status?: TemplateStatus
  category?: string
}

export class PermissionTemplateRepository extends BaseRepository<TemplateDocument> {
  constructor(db: Db) {
    super(getCollection(db, 'permission_templates'))
  }

  async ensureIndexes(): Promise<void> {
    await super.ensureIndexes([
      { key: { name: 1 }, unique: true },
      { key: { status: 1, category: 1, createdAt: -1 } },
    ])
  }

  async findByIdSafe(id: string): Promise<PermissionTemplateEntity | null> {
    const doc = await this.findById(id)
    return doc ? toEntity(doc) : null
  }

  async list(filters: TemplateListFilters): Promise<{ items: PermissionTemplateEntity[]; total: number }> {
    const match: Record<string, unknown> = {}
    if (filters.status) match.status = filters.status
    if (filters.category) match.category = filters.category
    if (filters.search?.trim()) {
      const rx = filters.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      match.$or = [{ name: { $regex: rx, $options: 'i' } }, { description: { $regex: rx, $options: 'i' } }]
    }
    const page = Math.max(1, filters.page ?? 1)
    const limit = Math.min(100, Math.max(1, filters.limit ?? 20))
    const skip = (page - 1) * limit
    const [docs, total] = await Promise.all([
      this.findMany(match as Filter<TemplateDocument>, { sort: { createdAt: -1 }, skip, limit }),
      this.count(match as Filter<TemplateDocument>),
    ])
    return { items: docs.map((d) => toEntity(d)), total }
  }

  async listActive(): Promise<PermissionTemplateEntity[]> {
    const docs = await this.findMany({ status: 'active' } as Filter<TemplateDocument>, { sort: { name: 1 } })
    return docs.map((d) => toEntity(d))
  }

  async create(input: {
    name: string
    description?: string
    permissionKeys: string[]
    category?: string
    color?: string
    icon?: string
    metadata?: Record<string, unknown>
    createdBy: string
  }): Promise<PermissionTemplateEntity> {
    const now = new Date()
    const id = await this.insertOne({
      name: input.name.trim(),
      description: input.description?.trim() ?? '',
      permissionKeys: expandPermissions(input.permissionKeys),
      category: input.category ?? null,
      color: input.color ?? null,
      icon: input.icon ?? null,
      metadata: input.metadata ?? {},
      version: 1,
      status: 'active',
      createdBy: input.createdBy,
      updatedBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    } as TemplateDocument)
    return (await this.findByIdSafe(id))!
  }

  async update(
    id: string,
    patch: Partial<Pick<TemplateDocument, 'name' | 'description' | 'permissionKeys' | 'category' | 'color' | 'icon' | 'metadata' | 'updatedBy'>>,
  ): Promise<PermissionTemplateEntity | null> {
    if (!ObjectId.isValid(id)) return null
    const $set: Record<string, unknown> = { updatedAt: new Date() }
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) $set[k] = k === 'permissionKeys' ? expandPermissions(v as string[]) : v
    }
    await this.collection.updateOne(
      { _id: new ObjectId(id), status: 'active' } as Filter<TemplateDocument>,
      { $set, $inc: { version: 1 } },
    )
    return this.findByIdSafe(id)
  }

  async archive(id: string): Promise<boolean> {
    if (!ObjectId.isValid(id)) return false
    const res = await this.collection.updateOne(
      { _id: new ObjectId(id), status: 'active' } as Filter<TemplateDocument>,
      { $set: { status: 'archived', archivedAt: new Date(), updatedAt: new Date() } },
    )
    return res.modifiedCount > 0
  }

  async restore(id: string): Promise<boolean> {
    if (!ObjectId.isValid(id)) return false
    const res = await this.collection.updateOne(
      { _id: new ObjectId(id), status: 'archived' } as Filter<TemplateDocument>,
      { $set: { status: 'active', archivedAt: null, updatedAt: new Date() } },
    )
    return res.modifiedCount > 0
  }

  async existsByName(name: string, excludeId?: string): Promise<boolean> {
    const filter: Record<string, unknown> = { name: name.trim() }
    if (excludeId && ObjectId.isValid(excludeId)) {
      filter._id = { $ne: new ObjectId(excludeId) }
    }
    return (await this.count(filter as Filter<TemplateDocument>)) > 0
  }
}

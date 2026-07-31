import { ObjectId, type Db, type Document, type Filter } from 'mongodb'
import { expandPermissions } from '../../../common/permissions/registry.js'
import { BaseRepository, getCollection } from '../../../database/repositories/base.repository.js'
import type { ConditionalPermissionEntity, ConditionalStatus } from '../domain/enterprise.entities.js'
import type { ConditionClause, ConditionLogic } from '../services/conditional-evaluation.js'

interface ConditionalDocument extends Document {
  name: string
  description: string
  permissionKeys: string[]
  conditions: ConditionClause[]
  logic: ConditionLogic
  priority: number
  status: ConditionalStatus
  appliesToUserId?: string | null
  createdBy: string
  updatedBy: string
  createdAt: Date
  updatedAt: Date
}

function toEntity(doc: ConditionalDocument & { _id: ObjectId }): ConditionalPermissionEntity {
  return {
    _id: doc._id.toString(),
    name: doc.name,
    description: doc.description ?? '',
    permissionKeys: expandPermissions(doc.permissionKeys ?? []),
    conditions: doc.conditions ?? [],
    logic: doc.logic ?? 'AND',
    priority: doc.priority ?? 0,
    status: doc.status ?? 'active',
    appliesToUserId: doc.appliesToUserId ?? null,
    createdBy: doc.createdBy,
    updatedBy: doc.updatedBy,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  }
}

export class ConditionalPermissionRepository extends BaseRepository<ConditionalDocument> {
  constructor(db: Db) {
    super(getCollection(db, 'conditional_permissions'))
  }

  async ensureIndexes(): Promise<void> {
    await super.ensureIndexes([
      { key: { status: 1, priority: -1 } },
      { key: { appliesToUserId: 1, status: 1 } },
      { key: { name: 1 }, unique: true },
    ])
  }

  async findByIdSafe(id: string): Promise<ConditionalPermissionEntity | null> {
    const doc = await this.findById(id)
    return doc ? toEntity(doc) : null
  }

  async list(filters: {
    page?: number
    limit?: number
    search?: string
    status?: ConditionalStatus
  }): Promise<{ items: ConditionalPermissionEntity[]; total: number }> {
    const match: Record<string, unknown> = {}
    if (filters.status) match.status = filters.status
    if (filters.search?.trim()) {
      const rx = filters.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      match.$or = [{ name: { $regex: rx, $options: 'i' } }, { description: { $regex: rx, $options: 'i' } }]
    }
    const page = Math.max(1, filters.page ?? 1)
    const limit = Math.min(100, Math.max(1, filters.limit ?? 20))
    const skip = (page - 1) * limit
    const [docs, total] = await Promise.all([
      this.findMany(match as Filter<ConditionalDocument>, { sort: { priority: -1, createdAt: -1 }, skip, limit }),
      this.count(match as Filter<ConditionalDocument>),
    ])
    return { items: docs.map((d) => toEntity(d)), total }
  }

  async listActive(): Promise<ConditionalPermissionEntity[]> {
    const docs = await this.findMany({ status: 'active' } as Filter<ConditionalDocument>, {
      sort: { priority: -1 },
    })
    return docs.map((d) => toEntity(d))
  }

  async create(input: {
    name: string
    description?: string
    permissionKeys: string[]
    conditions: ConditionClause[]
    logic?: ConditionLogic
    priority?: number
    appliesToUserId?: string | null
    createdBy: string
  }): Promise<ConditionalPermissionEntity> {
    const now = new Date()
    const id = await this.insertOne({
      name: input.name.trim(),
      description: input.description?.trim() ?? '',
      permissionKeys: expandPermissions(input.permissionKeys),
      conditions: input.conditions,
      logic: input.logic ?? 'AND',
      priority: input.priority ?? 0,
      status: 'active',
      appliesToUserId: input.appliesToUserId ?? null,
      createdBy: input.createdBy,
      updatedBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    } as ConditionalDocument)
    return (await this.findByIdSafe(id))!
  }

  async update(
    id: string,
    patch: Partial<Omit<ConditionalDocument, '_id'>>,
  ): Promise<ConditionalPermissionEntity | null> {
    if (!ObjectId.isValid(id)) return null
    const $set: Record<string, unknown> = { updatedAt: new Date() }
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) $set[k] = k === 'permissionKeys' ? expandPermissions(v as string[]) : v
    }
    await this.collection.updateOne({ _id: new ObjectId(id) } as Filter<ConditionalDocument>, { $set })
    return this.findByIdSafe(id)
  }

  async setStatus(id: string, status: ConditionalStatus): Promise<boolean> {
    if (!ObjectId.isValid(id)) return false
    const res = await this.collection.updateOne(
      { _id: new ObjectId(id) } as Filter<ConditionalDocument>,
      { $set: { status, updatedAt: new Date() } },
    )
    return res.modifiedCount > 0
  }

  async deleteSafe(id: string): Promise<boolean> {
    return this.deleteById(id)
  }
}

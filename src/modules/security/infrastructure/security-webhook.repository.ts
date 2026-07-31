import { ObjectId, type Db, type Document, type Filter } from 'mongodb'
import { BaseRepository, getCollection } from '../../../database/repositories/base.repository.js'
import type { SecurityWebhookEntity, WebhookEventType } from '../domain/enterprise.entities.js'

interface WebhookDocument extends Document {
  name: string
  url: string
  secret?: string | null
  events: WebhookEventType[]
  isActive: boolean
  createdBy: string
  updatedBy: string
  createdAt: Date
  updatedAt: Date
  lastTriggeredAt?: Date | null
  failureCount?: number
}

function toEntity(doc: WebhookDocument & { _id: ObjectId }): SecurityWebhookEntity {
  return {
    _id: doc._id.toString(),
    name: doc.name,
    url: doc.url,
    secret: doc.secret ?? null,
    events: doc.events ?? [],
    isActive: doc.isActive ?? true,
    createdBy: doc.createdBy,
    updatedBy: doc.updatedBy,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    lastTriggeredAt: doc.lastTriggeredAt ?? null,
    failureCount: doc.failureCount ?? 0,
  }
}

export class SecurityWebhookRepository extends BaseRepository<WebhookDocument> {
  constructor(db: Db) {
    super(getCollection(db, 'security_webhooks'))
  }

  async ensureIndexes(): Promise<void> {
    await super.ensureIndexes([{ key: { isActive: 1 } }, { key: { createdAt: -1 } }])
  }

  async list(): Promise<SecurityWebhookEntity[]> {
    const docs = await this.findMany({}, { sort: { createdAt: -1 } })
    return docs.map((d) => toEntity(d))
  }

  async findByIdSafe(id: string): Promise<SecurityWebhookEntity | null> {
    const doc = await this.findById(id)
    return doc ? toEntity(doc) : null
  }

  async create(input: {
    name: string
    url: string
    secret?: string
    events: WebhookEventType[]
    createdBy: string
  }): Promise<SecurityWebhookEntity> {
    const now = new Date()
    const id = await this.insertOne({
      name: input.name.trim(),
      url: input.url.trim(),
      secret: input.secret ?? null,
      events: input.events,
      isActive: true,
      createdBy: input.createdBy,
      updatedBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
      lastTriggeredAt: null,
      failureCount: 0,
    } as WebhookDocument)
    return (await this.findByIdSafe(id))!
  }

  async update(
    id: string,
    patch: Partial<Pick<WebhookDocument, 'name' | 'url' | 'secret' | 'events' | 'isActive' | 'updatedBy'>>,
  ): Promise<SecurityWebhookEntity | null> {
    if (!ObjectId.isValid(id)) return null
    await this.collection.updateOne(
      { _id: new ObjectId(id) } as Filter<WebhookDocument>,
      { $set: { ...patch, updatedAt: new Date() } },
    )
    return this.findByIdSafe(id)
  }

  async deleteSafe(id: string): Promise<boolean> {
    return this.deleteById(id)
  }
}

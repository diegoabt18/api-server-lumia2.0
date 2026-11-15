import { ObjectId, type Collection, type Db, type Filter, type WithId } from 'mongodb'
import type { KnowledgeEvent, KnowledgeStore, NewKnowledge } from '../domain/knowledge.store.js'
import {
  LAST_MESSAGE_TTL_MS,
  type KnowledgeScope,
  type KnowledgeSource,
  type KnowledgeStatus,
  type ListKnowledgeQuery,
  type LumiKnowledge,
} from '../domain/knowledge.types.js'

interface KnowledgeDocument {
  _id: ObjectId
  kind: 'interpretation'
  scope: KnowledgeScope
  userId: string | null
  phrase: string
  phraseNorm: string
  tool: string
  status: KnowledgeStatus
  source: KnowledgeSource
  conversationId: string | null
  uses: number
  lastUsedAt: Date | null
  createdBy: string
  createdAt: Date
  updatedAt: Date
}

interface EventDocument extends Omit<KnowledgeEvent, 'knowledgeId'> {
  _id: ObjectId
  knowledgeId: ObjectId
}

interface LastMessageDocument {
  _id: string
  message: string
  at: Date
  expiresAt: Date
}

const oid = (id: string): ObjectId | null => (ObjectId.isValid(id) && id.length === 24 ? new ObjectId(id) : null)
const escapeRegex = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function knowledgeFrom(doc: WithId<KnowledgeDocument>): LumiKnowledge {
  return {
    id: doc._id.toString(),
    kind: 'interpretation',
    scope: doc.scope,
    userId: doc.userId,
    phrase: doc.phrase,
    phraseNorm: doc.phraseNorm,
    tool: doc.tool,
    status: doc.status,
    source: doc.source,
    conversationId: doc.conversationId ?? null,
    uses: doc.uses ?? 0,
    lastUsedAt: doc.lastUsedAt ?? null,
    createdBy: doc.createdBy,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  }
}

/** lumi_knowledge, lumi_knowledge_events y lumi_last_messages (identity_db). */
export class LumiKnowledgeRepository implements KnowledgeStore {
  private readonly knowledge: Collection<KnowledgeDocument>
  private readonly events: Collection<EventDocument>
  private readonly lastMessages: Collection<LastMessageDocument>

  constructor(db: Db) {
    this.knowledge = db.collection<KnowledgeDocument>('lumi_knowledge')
    this.events = db.collection<EventDocument>('lumi_knowledge_events')
    this.lastMessages = db.collection<LastMessageDocument>('lumi_last_messages')
  }

  async ensureIndexes(): Promise<void> {
    await this.knowledge.createIndex({ phraseNorm: 1, status: 1, scope: 1, userId: 1 }, { name: 'lumi_knowledge_phrase' })
    await this.knowledge.createIndex({ scope: 1, userId: 1, status: 1, updatedAt: -1 }, { name: 'lumi_knowledge_scope_user_status' })
    await this.knowledge.createIndex({ tool: 1, status: 1 }, { name: 'lumi_knowledge_tool_status' })
    await this.knowledge.createIndex({ status: 1, updatedAt: -1 }, { name: 'lumi_knowledge_status_recent' })
    await this.events.createIndex({ knowledgeId: 1, at: -1 }, { name: 'lumi_knowledge_events_knowledge' })
    await this.lastMessages.createIndex({ expiresAt: 1 }, { name: 'lumi_last_messages_ttl', expireAfterSeconds: 0 })
  }

  async create(input: NewKnowledge): Promise<LumiKnowledge> {
    const doc: KnowledgeDocument = {
      _id: new ObjectId(),
      kind: 'interpretation',
      scope: input.scope,
      userId: input.userId,
      phrase: input.phrase,
      phraseNorm: input.phraseNorm,
      tool: input.tool,
      status: input.status,
      source: input.source,
      conversationId: input.conversationId,
      uses: 0,
      lastUsedAt: null,
      createdBy: input.createdBy,
      createdAt: input.now,
      updatedAt: input.now,
    }
    await this.knowledge.insertOne(doc)
    return knowledgeFrom(doc)
  }

  async findById(id: string): Promise<LumiKnowledge | null> {
    const _id = oid(id)
    if (!_id) return null
    const doc = await this.knowledge.findOne({ _id })
    return doc ? knowledgeFrom(doc) : null
  }

  async findApproved(userId: string, phraseNorm: string): Promise<LumiKnowledge[]> {
    const docs = await this.knowledge
      .find({ phraseNorm, status: 'approved', $or: [{ scope: 'user', userId }, { scope: 'global' }] })
      .sort({ updatedAt: -1 })
      .limit(10)
      .toArray()
    return docs.map(knowledgeFrom)
  }

  async listApprovedFor(userId: string, limit: number): Promise<LumiKnowledge[]> {
    const docs = await this.knowledge
      .find({ status: 'approved', $or: [{ scope: 'user', userId }, { scope: 'global' }] })
      .sort({ updatedAt: -1 })
      .limit(limit)
      .toArray()
    return docs.map(knowledgeFrom)
  }

  async findByPhrase(scope: KnowledgeScope, userId: string | null, phraseNorm: string, statuses: readonly KnowledgeStatus[]): Promise<LumiKnowledge[]> {
    const docs = await this.knowledge.find({ scope, userId, phraseNorm, status: { $in: [...statuses] } }).toArray()
    return docs.map(knowledgeFrom)
  }

  async findPendingConfirmation(userId: string, since: Date): Promise<LumiKnowledge | null> {
    const doc = await this.knowledge.findOne(
      { scope: 'user', userId, status: 'detected', source: 'text', createdAt: { $gte: since } },
      { sort: { createdAt: -1 } },
    )
    return doc ? knowledgeFrom(doc) : null
  }

  async countActiveForUser(userId: string): Promise<number> {
    return this.knowledge.countDocuments({ scope: 'user', userId, status: { $in: ['approved', 'detected', 'pending_review'] } })
  }

  async setStatus(id: string, status: KnowledgeStatus, at: Date): Promise<void> {
    const _id = oid(id)
    if (!_id) return
    // Al resolverse la confirmación deja de importar la conversación.
    await this.knowledge.updateOne({ _id }, { $set: { status, updatedAt: at, ...(status !== 'detected' ? { conversationId: null } : {}) } })
  }

  async markUsed(id: string, at: Date): Promise<void> {
    const _id = oid(id)
    if (!_id) return
    await this.knowledge.updateOne({ _id }, { $inc: { uses: 1 }, $set: { lastUsedAt: at } })
  }

  async delete(id: string): Promise<boolean> {
    const _id = oid(id)
    if (!_id) return false
    return (await this.knowledge.deleteOne({ _id })).deletedCount === 1
  }

  async list(query: ListKnowledgeQuery): Promise<{ items: LumiKnowledge[]; total: number }> {
    const filter: Filter<KnowledgeDocument> = {}
    if (query.scope) filter.scope = query.scope
    if (query.status) filter.status = query.status
    if (query.tool) filter.tool = query.tool
    if (query.search) filter.phrase = new RegExp(escapeRegex(query.search), 'i')
    const [docs, total] = await Promise.all([
      this.knowledge
        .find(filter)
        .sort({ updatedAt: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .toArray(),
      this.knowledge.countDocuments(filter),
    ])
    return { items: docs.map(knowledgeFrom), total }
  }

  async addEvent(event: KnowledgeEvent): Promise<void> {
    const knowledgeId = oid(event.knowledgeId)
    if (!knowledgeId) return
    await this.events.insertOne({ _id: new ObjectId(), ...event, knowledgeId })
  }

  async listEvents(knowledgeId: string, limit: number): Promise<KnowledgeEvent[]> {
    const id = oid(knowledgeId)
    if (!id) return []
    const docs = await this.events.find({ knowledgeId: id }).sort({ at: -1 }).limit(limit).toArray()
    return docs.map((d) => ({ knowledgeId: d.knowledgeId.toString(), at: d.at, by: d.by, action: d.action, from: d.from, to: d.to }))
  }

  async setLastMessage(userId: string, message: string, at: Date): Promise<void> {
    await this.lastMessages.updateOne(
      { _id: userId },
      { $set: { message, at, expiresAt: new Date(at.getTime() + LAST_MESSAGE_TTL_MS) } },
      { upsert: true },
    )
  }

  async getLastMessage(userId: string, since: Date): Promise<string | null> {
    const doc = await this.lastMessages.findOne({ _id: userId, at: { $gte: since } })
    return doc?.message ?? null
  }
}

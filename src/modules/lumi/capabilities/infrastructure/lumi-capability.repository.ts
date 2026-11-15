import { ObjectId, type Collection, type Db, type Filter, type Sort, type WithId } from 'mongodb'
import type {
  ToolCapabilityInput,
  CapabilityPatch,
  CapabilityStats,
  CapabilityStore,
  NewCapability,
  NewCapabilityRequest,
} from '../domain/capability.store.js'
import {
  EMPTY_SPEC,
  HISTORY_LIMIT,
  SAMPLE_LIMIT,
  type CapabilityHistoryEntry,
  type CapabilityLastTest,
  type CapabilityModule,
  type CapabilityPriority,
  type CapabilitySpec,
  type CapabilityStatus,
  type ListCapabilitiesQuery,
  type LumiCapability,
} from '../domain/capability.types.js'

interface CapabilityDocument {
  _id: ObjectId
  key: string
  title: string
  description: string
  module: CapabilityModule
  status: CapabilityStatus
  priority: CapabilityPriority
  signature: string
  keywords: string[]
  requestCount: number
  samples: string[]
  spec: CapabilitySpec
  mergedInto: ObjectId | null
  possibleDuplicateOf: ObjectId | null
  toolName?: string | null
  history: CapabilityHistoryEntry[]
  lastTest?: CapabilityLastTest | null
  firstSeenAt: Date
  lastSeenAt: Date
  createdAt: Date
  updatedAt: Date
}

interface RequestDocument {
  _id: ObjectId
  capabilityId: ObjectId
  userId: string
  conversationId: string | null
  message: string
  need: string
  module: CapabilityModule
  signature: string
  createdAt: Date
}

function capabilityFrom(doc: WithId<CapabilityDocument>): LumiCapability {
  return {
    id: doc._id.toString(),
    key: doc.key,
    title: doc.title,
    description: doc.description,
    module: doc.module,
    status: doc.status,
    priority: doc.priority,
    signature: doc.signature,
    keywords: doc.keywords,
    requestCount: doc.requestCount,
    samples: doc.samples,
    spec: { ...EMPTY_SPEC, ...doc.spec },
    mergedInto: doc.mergedInto?.toString() ?? null,
    possibleDuplicateOf: doc.possibleDuplicateOf?.toString() ?? null,
    toolName: doc.toolName ?? null,
    history: doc.history,
    lastTest: doc.lastTest ?? null,
    firstSeenAt: doc.firstSeenAt,
    lastSeenAt: doc.lastSeenAt,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const oid = (id: string): ObjectId | null => (ObjectId.isValid(id) && id.length === 24 ? new ObjectId(id) : null)

/** Capacidades que faltan y sus peticiones, en la base de identidad junto al resto de Lumi. */
export class LumiCapabilityRepository implements CapabilityStore {
  private readonly capabilities: Collection<CapabilityDocument>
  private readonly requests: Collection<RequestDocument>

  constructor(db: Db) {
    this.capabilities = db.collection<CapabilityDocument>('lumi_capabilities')
    this.requests = db.collection<RequestDocument>('lumi_capability_requests')
  }

  async ensureIndexes(): Promise<void> {
    await this.capabilities.createIndex({ key: 1 }, { unique: true, name: 'lumi_capabilities_key_unique' })
    await this.capabilities.createIndex({ keywords: 1, status: 1 }, { name: 'lumi_capabilities_keywords_status' })
    await this.capabilities.createIndex({ status: 1, lastSeenAt: -1 }, { name: 'lumi_capabilities_status_recent' })
    await this.capabilities.createIndex({ module: 1, status: 1 }, { name: 'lumi_capabilities_module_status' })
    await this.capabilities.createIndex({ requestCount: -1 }, { name: 'lumi_capabilities_request_count' })
    await this.capabilities.createIndex({ toolName: 1, status: 1 }, { name: 'lumi_capabilities_tool_status' })
    await this.requests.createIndex({ capabilityId: 1, createdAt: -1 }, { name: 'lumi_capability_requests_capability' })
    await this.requests.createIndex(
      { userId: 1, signature: 1, createdAt: -1 },
      { name: 'lumi_capability_requests_user_signature' },
    )
    await this.requests.createIndex({ createdAt: -1 }, { name: 'lumi_capability_requests_created' })
  }

  async create(input: NewCapability): Promise<LumiCapability> {
    const doc: CapabilityDocument = {
      _id: new ObjectId(),
      key: input.key,
      title: input.title,
      description: '',
      module: input.module,
      status: 'detected',
      priority: 'normal',
      signature: input.signature,
      keywords: input.keywords,
      requestCount: 1,
      samples: [input.sample],
      spec: { ...EMPTY_SPEC },
      mergedInto: null,
      possibleDuplicateOf: input.possibleDuplicateOf ? oid(input.possibleDuplicateOf) : null,
      toolName: null,
      history: [{ at: input.now, by: 'system', action: 'created' }],
      lastTest: null,
      firstSeenAt: input.now,
      lastSeenAt: input.now,
      createdAt: input.now,
      updatedAt: input.now,
    }
    await this.capabilities.insertOne(doc)
    return capabilityFrom(doc)
  }

  async findById(id: string): Promise<LumiCapability | null> {
    const _id = oid(id)
    if (!_id) return null
    const doc = await this.capabilities.findOne({ _id })
    return doc ? capabilityFrom(doc) : null
  }

  async findCandidates(keywords: readonly string[], limit: number): Promise<LumiCapability[]> {
    if (keywords.length === 0) return []
    const docs = await this.capabilities
      .find({ keywords: { $in: [...keywords] } })
      .sort({ lastSeenAt: -1 })
      .limit(limit)
      .toArray()
    return docs.map(capabilityFrom)
  }

  async addRequest(id: string, sample: string, at: Date): Promise<void> {
    const _id = oid(id)
    if (!_id) return
    await this.capabilities.updateOne(
      { _id },
      {
        $inc: { requestCount: 1 },
        $set: { lastSeenAt: at, updatedAt: at },
        $push: { samples: { $each: [sample], $slice: -SAMPLE_LIMIT } },
      },
    )
  }

  async insertRequest(request: NewCapabilityRequest): Promise<void> {
    const capabilityId = oid(request.capabilityId)
    if (!capabilityId) return
    await this.requests.insertOne({ _id: new ObjectId(), ...request, capabilityId })
  }

  async hasRecentRequest(userId: string, signature: string, since: Date): Promise<boolean> {
    const found = await this.requests.findOne({ userId, signature, createdAt: { $gte: since } }, { projection: { _id: 1 } })
    return found !== null
  }

  async list(query: ListCapabilitiesQuery): Promise<{ items: LumiCapability[]; total: number }> {
    const filter: Filter<CapabilityDocument> = {}
    if (query.status) filter.status = query.status
    if (query.module) filter.module = query.module
    if (query.priority) filter.priority = query.priority
    if (query.search) {
      const pattern = new RegExp(escapeRegex(query.search), 'i')
      filter.$or = [{ title: pattern }, { description: pattern }, { samples: pattern }, { key: pattern }]
    }
    const sort: Sort =
      query.sort === 'requests'
        ? { requestCount: -1, lastSeenAt: -1 }
        : query.sort === 'created'
          ? { createdAt: -1 }
          : { lastSeenAt: -1 }
    const [docs, total] = await Promise.all([
      this.capabilities
        .find(filter)
        .sort(sort)
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .toArray(),
      this.capabilities.countDocuments(filter),
    ])
    return { items: docs.map(capabilityFrom), total }
  }

  async stats(since: Date): Promise<CapabilityStats> {
    const [byStatus, byModule, total, requestsSince] = await Promise.all([
      this.capabilities.aggregate<{ _id: CapabilityStatus; n: number }>([{ $group: { _id: '$status', n: { $sum: 1 } } }]).toArray(),
      this.capabilities
        .aggregate<{ _id: CapabilityModule; n: number }>([
          { $match: { status: { $nin: ['duplicate', 'rejected'] } } },
          { $group: { _id: '$module', n: { $sum: 1 } } },
        ])
        .toArray(),
      this.capabilities.countDocuments({}),
      this.requests.countDocuments({ createdAt: { $gte: since } }),
    ])
    return {
      total,
      byStatus: Object.fromEntries(byStatus.map((r) => [r._id, r.n])),
      byModule: Object.fromEntries(byModule.map((r) => [r._id, r.n])),
      requestsSince,
    }
  }

  async recentRequests(capabilityId: string, limit: number): Promise<Array<{ message: string; createdAt: Date }>> {
    const _id = oid(capabilityId)
    if (!_id) return []
    const docs = await this.requests
      .find({ capabilityId: _id }, { projection: { message: 1, createdAt: 1 } })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray()
    return docs.map((d) => ({ message: d.message, createdAt: d.createdAt }))
  }

  async distinctUsers(capabilityId: string): Promise<number> {
    const _id = oid(capabilityId)
    if (!_id) return 0
    return (await this.requests.distinct('userId', { capabilityId: _id })).length
  }

  async update(id: string, patch: CapabilityPatch, entry: CapabilityHistoryEntry, at: Date): Promise<void> {
    const _id = oid(id)
    if (!_id) return
    const { mergedInto, possibleDuplicateOf, ...plain } = patch
    const set: Partial<CapabilityDocument> = { ...plain, updatedAt: at }
    if (mergedInto !== undefined) set.mergedInto = mergedInto ? oid(mergedInto) : null
    if (possibleDuplicateOf !== undefined) set.possibleDuplicateOf = possibleDuplicateOf ? oid(possibleDuplicateOf) : null
    await this.capabilities.updateOne(
      { _id },
      { $set: set, $push: { history: { $each: [entry], $slice: -HISTORY_LIMIT } } },
    )
  }

  async absorb(
    targetId: string,
    sourceId: string,
    requestCount: number,
    samples: string[],
    entry: CapabilityHistoryEntry,
    at: Date,
  ): Promise<void> {
    const target = oid(targetId)
    const source = oid(sourceId)
    if (!target || !source) return
    await this.requests.updateMany({ capabilityId: source }, { $set: { capabilityId: target } })
    await this.capabilities.updateOne(
      { _id: target },
      {
        $inc: { requestCount },
        $set: { updatedAt: at },
        $push: {
          samples: { $each: samples, $slice: -SAMPLE_LIMIT },
          history: { $each: [entry], $slice: -HISTORY_LIMIT },
        },
      },
    )
    // Fusiones anteriores en la origen pasan al destino: nunca hay cadenas de duplicados.
    await this.capabilities.updateMany({ mergedInto: source }, { $set: { mergedInto: target } })
    // Lo que apuntaba a la fusionada como posible duplicado ahora apunta al destino.
    await this.capabilities.updateMany(
      { possibleDuplicateOf: source, _id: { $ne: target } },
      { $set: { possibleDuplicateOf: target } },
    )
    await this.capabilities.updateOne({ _id: target, possibleDuplicateOf: source }, { $set: { possibleDuplicateOf: null } })
  }

  async upsertForTool(input: ToolCapabilityInput): Promise<'created' | 'linked' | 'unchanged'> {
    const existing = await this.capabilities.findOne({ key: input.key }, { projection: { toolName: 1 } })
    if (existing) {
      if (existing.toolName === input.toolName) return 'unchanged'
      await this.capabilities.updateOne(
        { _id: existing._id },
        {
          $set: { toolName: input.toolName, updatedAt: input.now },
          $push: { history: { $each: [{ at: input.now, by: 'system', action: 'implemented' as const, to: input.toolName }], $slice: -HISTORY_LIMIT } },
        },
      )
      return 'linked'
    }
    const now = input.now
    // upsert por clave única: dos instancias arrancando a la vez no crean dos capacidades.
    const res = await this.capabilities.updateOne(
      { key: input.key },
      {
        $setOnInsert: {
          key: input.key,
          title: input.title,
          description: '',
          module: input.module,
          status: input.initialStatus,
          priority: 'normal',
          signature: `tool:${input.toolName}`,
          keywords: [],
          requestCount: 0,
          samples: [],
          spec: { ...EMPTY_SPEC },
          mergedInto: null,
          possibleDuplicateOf: null,
          toolName: input.toolName,
          history: [{ at: now, by: 'system', action: 'implemented', to: input.toolName }],
          lastTest: null,
          firstSeenAt: now,
          lastSeenAt: now,
          createdAt: now,
          updatedAt: now,
        },
      },
      { upsert: true },
    )
    return res.upsertedCount ? 'created' : 'unchanged'
  }

  async enabledToolNames(): Promise<string[]> {
    const docs = await this.capabilities
      .find({ toolName: { $ne: null }, status: 'enabled' }, { projection: { toolName: 1 } })
      .toArray()
    return docs.map((d) => d.toolName).filter((n): n is string => typeof n === 'string')
  }
}

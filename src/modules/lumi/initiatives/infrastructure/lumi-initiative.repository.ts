import { MongoServerError, ObjectId, type Collection, type Db, type WithId } from 'mongodb'
import type { InitiativeStore, InitiativePatch, NewInitiative } from '../domain/initiative.store.js'
import {
  DEFAULT_INITIATIVE_LEVEL,
  type InitiativeKind,
  type InitiativeLevel,
  type InitiativeState,
  type InitiativePriority,
  type LumiInitiative,
} from '../domain/initiative.types.js'

interface InitiativeDocument {
  _id: ObjectId
  userId: string
  kind: InitiativeKind
  subjectKey: string
  dedupKey: string
  title: string
  detail: string
  priority: InitiativePriority
  state: InitiativeState
  openCount: number
  firstSeenAt: Date
  lastSeenAt: Date
  stateChangedAt: Date
  resolvedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

interface SettingsDocument {
  _id: string
  level: InitiativeLevel
  updatedAt: Date
}

interface TaskRef {
  userId: string
  kind: string
  status: string
  parentTaskId: string | null
}

const DUPLICATE_KEY = 11000

function initiativeFrom(doc: WithId<InitiativeDocument>): LumiInitiative {
  return {
    id: doc._id.toString(),
    userId: doc.userId,
    kind: doc.kind,
    subjectKey: doc.subjectKey,
    dedupKey: doc.dedupKey,
    title: doc.title,
    detail: doc.detail,
    priority: doc.priority,
    state: doc.state,
    openCount: doc.openCount,
    firstSeenAt: doc.firstSeenAt,
    lastSeenAt: doc.lastSeenAt,
    stateChangedAt: doc.stateChangedAt,
    resolvedAt: doc.resolvedAt ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  }
}

/** Persistencia de iniciativas en la base de identidad, junto a las tareas de Lumi. */
export class LumiInitiativeRepository implements InitiativeStore {
  private readonly initiatives: Collection<InitiativeDocument>
  private readonly settings: Collection<SettingsDocument>
  private readonly tasks: Collection<TaskRef>

  constructor(db: Db) {
    this.initiatives = db.collection<InitiativeDocument>('lumi_initiatives')
    this.settings = db.collection<SettingsDocument>('lumi_initiative_settings')
    this.tasks = db.collection<TaskRef>('lumi_tasks')
  }

  async ensureIndexes(): Promise<void> {
    await this.initiatives.createIndex(
      { userId: 1, dedupKey: 1 },
      { unique: true, name: 'lumi_initiatives_user_dedupkey_unique' },
    )
    await this.initiatives.createIndex(
      { userId: 1, state: 1, priority: -1, lastSeenAt: -1 },
      { name: 'lumi_initiatives_user_state_priority' },
    )
  }

  async insert(item: NewInitiative): Promise<LumiInitiative | null> {
    const now = new Date()
    const _id = new ObjectId()
    try {
      await this.initiatives.insertOne({ _id, ...item, resolvedAt: null, createdAt: now, updatedAt: now })
    } catch (err) {
      if (err instanceof MongoServerError && err.code === DUPLICATE_KEY) return null
      throw err
    }
    return this.findForUser(_id.toString(), item.userId)
  }

  async findForUser(id: string, userId: string): Promise<LumiInitiative | null> {
    if (!ObjectId.isValid(id)) return null
    const doc = await this.initiatives.findOne({ _id: new ObjectId(id), userId })
    return doc ? initiativeFrom(doc) : null
  }

  async listForUser(userId: string, options: { state?: InitiativeState; limit: number }): Promise<LumiInitiative[]> {
    const docs = await this.initiatives
      .find({ userId, ...(options.state ? { state: options.state } : {}) })
      .sort({ priority: -1, lastSeenAt: -1 })
      .limit(options.limit)
      .toArray()
    return docs.map(initiativeFrom)
  }

  async update(id: string, patch: InitiativePatch): Promise<void> {
    await this.initiatives.updateOne(
      { _id: new ObjectId(id) },
      { $set: { ...patch, updatedAt: new Date() } },
    )
  }

  async getLevel(userId: string): Promise<InitiativeLevel> {
    const doc = await this.settings.findOne({ _id: userId })
    return doc?.level ?? DEFAULT_INITIATIVE_LEVEL
  }

  async setLevel(userId: string, level: InitiativeLevel): Promise<void> {
    await this.settings.updateOne(
      { _id: userId },
      { $set: { level, updatedAt: new Date() } },
      { upsert: true },
    )
  }

  async listUsersWithReviewRoutine(): Promise<string[]> {
    const users = await this.tasks.distinct('userId', {
      kind: 'initiative_review',
      status: 'active',
      parentTaskId: null,
    })
    return users
  }
}

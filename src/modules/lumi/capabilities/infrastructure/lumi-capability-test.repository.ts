import { ObjectId, type Collection, type Db, type WithId } from 'mongodb'
import type { CapabilityTestStore, NewPhrase, NewRun, RunPatch } from '../domain/capability-test.store.js'
import type {
  CapabilityPhrase,
  CapabilityTestRun,
  ExpectedStatus,
  PhraseResult,
  PhraseRole,
  RunStatus,
  RunSummary,
} from '../domain/capability-test.types.js'

interface PhraseDocument {
  _id: ObjectId
  capabilityId: ObjectId
  text: string
  role: PhraseRole
  expectedStatus: ExpectedStatus
  expectedTool: string | null
  critical: boolean
  createdBy: string
  createdAt: Date
}

interface RunDocument {
  _id: ObjectId
  capabilityId: ObjectId
  kind: CapabilityTestRun['kind']
  status: RunStatus
  forceSelector: boolean
  by: string
  results: PhraseResult[]
  summary: RunSummary | null
  error: string | null
  createdAt: Date
  finishedAt: Date | null
}

/** Las ejecuciones caducan solas: son diagnóstico, no historial permanente. */
export const TEST_RUN_TTL_SECONDS = 90 * 24 * 60 * 60

const oid = (id: string): ObjectId | null => (ObjectId.isValid(id) && id.length === 24 ? new ObjectId(id) : null)

function phraseFrom(doc: WithId<PhraseDocument>): CapabilityPhrase {
  return {
    id: doc._id.toString(),
    capabilityId: doc.capabilityId.toString(),
    text: doc.text,
    role: doc.role,
    expectedStatus: doc.expectedStatus,
    expectedTool: doc.expectedTool,
    critical: doc.critical,
    createdBy: doc.createdBy,
    createdAt: doc.createdAt,
  }
}

function runFrom(doc: WithId<RunDocument>): CapabilityTestRun {
  return {
    id: doc._id.toString(),
    capabilityId: doc.capabilityId.toString(),
    kind: doc.kind,
    status: doc.status,
    forceSelector: doc.forceSelector,
    by: doc.by,
    results: doc.results ?? [],
    summary: doc.summary ?? null,
    error: doc.error ?? null,
    createdAt: doc.createdAt,
    finishedAt: doc.finishedAt ?? null,
  }
}

export class LumiCapabilityTestRepository implements CapabilityTestStore {
  private readonly phrases: Collection<PhraseDocument>
  private readonly runs: Collection<RunDocument>

  constructor(db: Db) {
    this.phrases = db.collection<PhraseDocument>('lumi_capability_phrases')
    this.runs = db.collection<RunDocument>('lumi_capability_test_runs')
  }

  async ensureIndexes(): Promise<void> {
    await this.phrases.createIndex({ capabilityId: 1, role: 1 }, { name: 'lumi_capability_phrases_capability_role' })
    await this.runs.createIndex({ capabilityId: 1, createdAt: -1 }, { name: 'lumi_capability_test_runs_capability' })
    await this.runs.createIndex({ createdAt: 1 }, { name: 'lumi_capability_test_runs_ttl', expireAfterSeconds: TEST_RUN_TTL_SECONDS })
  }

  async addPhrase(phrase: NewPhrase): Promise<CapabilityPhrase> {
    const doc: PhraseDocument = { _id: new ObjectId(), ...phrase, capabilityId: oid(phrase.capabilityId)! }
    await this.phrases.insertOne(doc)
    return phraseFrom(doc)
  }

  async listPhrases(capabilityId: string): Promise<CapabilityPhrase[]> {
    const id = oid(capabilityId)
    if (!id) return []
    return (await this.phrases.find({ capabilityId: id }).sort({ createdAt: 1 }).toArray()).map(phraseFrom)
  }

  async countPhrases(capabilityId: string): Promise<number> {
    const id = oid(capabilityId)
    return id ? this.phrases.countDocuments({ capabilityId: id }) : 0
  }

  async deletePhrase(capabilityId: string, phraseId: string): Promise<boolean> {
    const id = oid(capabilityId)
    const pid = oid(phraseId)
    if (!id || !pid) return false
    return (await this.phrases.deleteOne({ _id: pid, capabilityId: id })).deletedCount === 1
  }

  async updatePhrase(
    capabilityId: string,
    phraseId: string,
    patch: Partial<Pick<CapabilityPhrase, 'role' | 'expectedStatus' | 'expectedTool' | 'critical'>>,
  ): Promise<CapabilityPhrase | null> {
    const id = oid(capabilityId)
    const pid = oid(phraseId)
    if (!id || !pid) return null
    const doc = await this.phrases.findOneAndUpdate({ _id: pid, capabilityId: id }, { $set: patch }, { returnDocument: 'after' })
    return doc ? phraseFrom(doc) : null
  }

  async movePhrases(fromCapabilityId: string, toCapabilityId: string): Promise<void> {
    const from = oid(fromCapabilityId)
    const to = oid(toCapabilityId)
    if (!from || !to) return
    await this.phrases.updateMany({ capabilityId: from }, { $set: { capabilityId: to } })
  }

  async createRun(run: NewRun): Promise<CapabilityTestRun> {
    const doc: RunDocument = {
      _id: new ObjectId(),
      ...run,
      capabilityId: oid(run.capabilityId)!,
      status: 'running',
      results: [],
      summary: null,
      error: null,
      finishedAt: null,
    }
    await this.runs.insertOne(doc)
    return runFrom(doc)
  }

  async updateRun(runId: string, patch: RunPatch): Promise<void> {
    const id = oid(runId)
    if (!id) return
    await this.runs.updateOne({ _id: id }, { $set: patch })
  }

  async getRun(capabilityId: string, runId: string): Promise<CapabilityTestRun | null> {
    const id = oid(capabilityId)
    const rid = oid(runId)
    if (!id || !rid) return null
    const doc = await this.runs.findOne({ _id: rid, capabilityId: id })
    return doc ? runFrom(doc) : null
  }

  async listRuns(capabilityId: string, limit: number): Promise<Array<Omit<CapabilityTestRun, 'results'>>> {
    const id = oid(capabilityId)
    if (!id) return []
    const docs = await this.runs
      .find({ capabilityId: id }, { projection: { results: 0 } })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray()
    return docs.map((d) => ({
      id: d._id.toString(),
      capabilityId: d.capabilityId.toString(),
      kind: d.kind,
      status: d.status,
      forceSelector: d.forceSelector,
      by: d.by,
      summary: d.summary ?? null,
      error: d.error ?? null,
      createdAt: d.createdAt,
      finishedAt: d.finishedAt ?? null,
    }))
  }

  async findRunning(capabilityId: string, since: Date): Promise<CapabilityTestRun | null> {
    const id = oid(capabilityId)
    if (!id) return null
    const doc = await this.runs.findOne({ capabilityId: id, status: 'running', createdAt: { $gte: since } })
    return doc ? runFrom(doc) : null
  }
}

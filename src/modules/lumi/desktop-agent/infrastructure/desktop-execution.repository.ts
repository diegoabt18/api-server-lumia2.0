import type { Collection, Db } from 'mongodb'
import type { TaskError, TaskOutcome, TaskState } from '../domain/protocol.js'

export type ExecutionStatus = 'dispatched' | TaskState | TaskOutcome | 'timed_out'

export const FINAL_STATUSES: readonly ExecutionStatus[] = [
  'completed',
  'unverified',
  'failed',
  'rejected',
  'cancelled',
  'timed_out',
]

/**
 * Registro de auditoría de cada ejecución: quién, en qué equipo, qué operación, con qué
 * autorización y cómo terminó. No guarda el resultado (puede contener contenido de páginas) ni
 * valores escritos: `argsSummary` es un resumen sin datos privados.
 */
export interface DesktopExecution {
  id: string
  deviceId: string
  userId: string
  /** `jti` del grant firmado. */
  authorizationId: string
  operation: string
  argsSummary: Record<string, unknown>
  status: ExecutionStatus
  timeoutMs: number
  grantExpiresAt: Date
  createdAt: Date
  updatedAt: Date
  finishedAt: Date | null
  durationMs: number | null
  verification: { verified: boolean; method: string } | null
  error: TaskError | null
  cancelRequested: boolean
}

export interface DesktopExecutionStore {
  insert(execution: DesktopExecution): Promise<void>
  findById(id: string): Promise<DesktopExecution | null>
  listByDevice(deviceId: string, limit: number): Promise<DesktopExecution[]>
  /** Actualiza solo si la ejecución no ha terminado. Devuelve la versión actualizada o null. */
  updateIfOpen(id: string, patch: Partial<DesktopExecution>): Promise<DesktopExecution | null>
  /** Ejecuciones de un equipo que siguen abiertas (para reenviar tras una reconexión). */
  listOpenByDevice(deviceId: string): Promise<DesktopExecution[]>
}

type ExecutionDocument = Omit<DesktopExecution, 'id'> & { _id: string }

function fromDoc(doc: ExecutionDocument | null): DesktopExecution | null {
  if (!doc) return null
  const { _id, ...rest } = doc
  return { ...rest, id: _id }
}

export class MongoDesktopExecutionStore implements DesktopExecutionStore {
  private readonly collection: Collection<ExecutionDocument>

  constructor(db: Db) {
    this.collection = db.collection<ExecutionDocument>('desktop_executions')
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex(
      { deviceId: 1, createdAt: -1 },
      { name: 'desktop_executions_device' },
    )
    await this.collection.createIndex(
      { userId: 1, createdAt: -1 },
      { name: 'desktop_executions_user' },
    )
    // Historial de 180 días.
    await this.collection.createIndex(
      { createdAt: 1 },
      { expireAfterSeconds: 180 * 24 * 3600, name: 'desktop_executions_ttl' },
    )
  }

  async insert(execution: DesktopExecution): Promise<void> {
    const { id, ...rest } = execution
    await this.collection.insertOne({ ...rest, _id: id })
  }

  async findById(id: string): Promise<DesktopExecution | null> {
    return fromDoc(await this.collection.findOne({ _id: id }))
  }

  async listByDevice(deviceId: string, limit: number): Promise<DesktopExecution[]> {
    const docs = await this.collection
      .find({ deviceId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray()
    return docs.map((d) => fromDoc(d) as DesktopExecution)
  }

  async updateIfOpen(
    id: string,
    patch: Partial<DesktopExecution>,
  ): Promise<DesktopExecution | null> {
    const fields = { ...patch }
    delete fields.id
    return fromDoc(
      await this.collection.findOneAndUpdate(
        { _id: id, status: { $nin: [...FINAL_STATUSES] } },
        { $set: fields },
        { returnDocument: 'after' },
      ),
    )
  }

  async listOpenByDevice(deviceId: string): Promise<DesktopExecution[]> {
    const docs = await this.collection
      .find({ deviceId, status: { $nin: [...FINAL_STATUSES] } })
      .limit(50)
      .toArray()
    return docs.map((d) => fromDoc(d) as DesktopExecution)
  }
}

export class MemoryDesktopExecutionStore implements DesktopExecutionStore {
  readonly items = new Map<string, DesktopExecution>()

  async insert(execution: DesktopExecution): Promise<void> {
    this.items.set(execution.id, { ...execution })
  }

  async findById(id: string): Promise<DesktopExecution | null> {
    const e = this.items.get(id)
    return e ? { ...e } : null
  }

  async listByDevice(deviceId: string, limit: number): Promise<DesktopExecution[]> {
    return [...this.items.values()]
      .filter((e) => e.deviceId === deviceId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
      .map((e) => ({ ...e }))
  }

  async updateIfOpen(
    id: string,
    patch: Partial<DesktopExecution>,
  ): Promise<DesktopExecution | null> {
    const e = this.items.get(id)
    if (!e || FINAL_STATUSES.includes(e.status)) return null
    const fields = { ...patch }
    delete fields.id
    Object.assign(e, fields)
    return { ...e }
  }

  async listOpenByDevice(deviceId: string): Promise<DesktopExecution[]> {
    return [...this.items.values()]
      .filter((e) => e.deviceId === deviceId && !FINAL_STATUSES.includes(e.status))
      .map((e) => ({ ...e }))
  }
}

import { randomUUID } from 'node:crypto'
import type { Collection, Db } from 'mongodb'

/**
 * Aprobaciones recordadas de Lumi Chat («sí, no vuelvas a preguntar»): un tipo de acción en un
 * destino (sitio o aplicación) de un equipo. Solo evitan volver a preguntar; los permisos y la
 * propiedad del equipo se comprueban igual en cada ejecución. Se pueden retirar en cualquier momento.
 */
export interface DesktopApproval {
  id: string
  userId: string
  deviceId: string
  /** open_page | click_page | type_page | click_app | type_app */
  kind: string
  /** Host del sitio o nombre de la aplicación, en minúsculas. */
  target: string
  createdAt: Date
}

export type DesktopApprovalKey = Pick<DesktopApproval, 'deviceId' | 'kind' | 'target'>

export const APPROVAL_KINDS = [
  'open_page',
  'click_page',
  'type_page',
  'click_app',
  'type_app',
] as const

export interface DesktopApprovalStore {
  has(userId: string, key: DesktopApprovalKey): Promise<boolean>
  add(userId: string, key: DesktopApprovalKey, now: Date): Promise<void>
  list(userId: string): Promise<DesktopApproval[]>
  /** Retira una aprobación propia. false si no existe o es de otra persona. */
  remove(userId: string, id: string): Promise<boolean>
  /** Al revocar un equipo, sus aprobaciones dejan de existir. */
  removeForDevice(deviceId: string): Promise<void>
}

function normalized(key: DesktopApprovalKey): DesktopApprovalKey {
  return { deviceId: key.deviceId, kind: key.kind, target: key.target.trim().toLowerCase() }
}

type ApprovalDocument = Omit<DesktopApproval, 'id'> & { _id: string }

export class MongoDesktopApprovalStore implements DesktopApprovalStore {
  private readonly collection: Collection<ApprovalDocument>

  constructor(db: Db) {
    this.collection = db.collection<ApprovalDocument>('desktop_approvals')
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex(
      { userId: 1, deviceId: 1, kind: 1, target: 1 },
      { unique: true, name: 'desktop_approvals_key' },
    )
    await this.collection.createIndex({ deviceId: 1 }, { name: 'desktop_approvals_device' })
  }

  async has(userId: string, key: DesktopApprovalKey): Promise<boolean> {
    return (await this.collection.countDocuments({ userId, ...normalized(key) }, { limit: 1 })) > 0
  }

  async add(userId: string, key: DesktopApprovalKey, now: Date): Promise<void> {
    await this.collection.updateOne(
      { userId, ...normalized(key) },
      { $setOnInsert: { _id: randomUUID(), userId, ...normalized(key), createdAt: now } },
      { upsert: true },
    )
  }

  async list(userId: string): Promise<DesktopApproval[]> {
    const docs = await this.collection.find({ userId }).sort({ createdAt: -1 }).limit(200).toArray()
    return docs.map(({ _id, ...rest }) => ({ ...rest, id: _id }))
  }

  async remove(userId: string, id: string): Promise<boolean> {
    return (await this.collection.deleteOne({ _id: id, userId })).deletedCount === 1
  }

  async removeForDevice(deviceId: string): Promise<void> {
    await this.collection.deleteMany({ deviceId })
  }
}

export class MemoryDesktopApprovalStore implements DesktopApprovalStore {
  readonly items: DesktopApproval[] = []

  async has(userId: string, key: DesktopApprovalKey): Promise<boolean> {
    const k = normalized(key)
    return this.items.some(
      (a) =>
        a.userId === userId &&
        a.deviceId === k.deviceId &&
        a.kind === k.kind &&
        a.target === k.target,
    )
  }

  async add(userId: string, key: DesktopApprovalKey, now: Date): Promise<void> {
    if (await this.has(userId, key)) return
    this.items.push({ id: randomUUID(), userId, ...normalized(key), createdAt: now })
  }

  async list(userId: string): Promise<DesktopApproval[]> {
    return this.items.filter((a) => a.userId === userId)
  }

  async remove(userId: string, id: string): Promise<boolean> {
    const index = this.items.findIndex((a) => a.id === id && a.userId === userId)
    if (index < 0) return false
    this.items.splice(index, 1)
    return true
  }

  async removeForDevice(deviceId: string): Promise<void> {
    for (let i = this.items.length - 1; i >= 0; i -= 1) {
      if (this.items[i]!.deviceId === deviceId) this.items.splice(i, 1)
    }
  }
}

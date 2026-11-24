import { ObjectId, type Collection, type Db } from 'mongodb'

/**
 * Acciones de Lumi que esperan la confirmación explícita de la persona. Lumi nunca ejecuta una
 * operación destructiva en el mismo turno en que la interpreta: primero describe exactamente qué hará,
 * guarda la acción pendiente y solo la ejecuta cuando el usuario confirma. Caducan solas.
 */

export const PENDING_ACTION_TTL_MS = 10 * 60_000

export type PendingActionKind = 'delete_routine' | 'desktop_action'

export interface PendingAction {
  id: string
  userId: string
  kind: PendingActionKind
  /** Identificadores que la confirmación ejecutará. Nunca texto libre del usuario. */
  payload: Record<string, string>
  /** Descripción mostrada al pedir la confirmación. */
  summary: string
  createdAt: Date
  expiresAt: Date
}

export interface PendingActionStore {
  /** Guarda la acción y sustituye cualquier otra pendiente del mismo tipo para ese usuario. */
  put(action: Omit<PendingAction, 'id'>): Promise<PendingAction>
  /**
   * Toma (y borra) la acción vigente del usuario. Solo una confirmación puede consumirla. Con `id`,
   * solo si es esa acción (un botón de una tarjeta antigua no confirma otra más reciente).
   */
  take(userId: string, kind: PendingActionKind, now: Date, id?: string): Promise<PendingAction | null>
  /** Descarta las acciones pendientes del usuario. Devuelve cuántas había vigentes. */
  discard(userId: string, now: Date): Promise<number>
  /** ¿Tiene el usuario alguna acción vigente? */
  hasPending(userId: string, now: Date): Promise<boolean>
}

/** Implementación en memoria (pruebas y desarrollo sin Mongo). */
export class MemoryPendingActions implements PendingActionStore {
  private readonly items = new Map<string, PendingAction>()

  private key(userId: string, kind: PendingActionKind) {
    return `${userId}|${kind}`
  }

  async put(action: Omit<PendingAction, 'id'>): Promise<PendingAction> {
    const saved = { ...action, id: new ObjectId().toHexString() }
    this.items.set(this.key(action.userId, action.kind), saved)
    return saved
  }

  async take(userId: string, kind: PendingActionKind, now: Date, id?: string): Promise<PendingAction | null> {
    const key = this.key(userId, kind)
    const item = this.items.get(key)
    if (id !== undefined && item?.id !== id) return null
    this.items.delete(key)
    return item && item.expiresAt > now ? item : null
  }

  async discard(userId: string, now: Date): Promise<number> {
    let count = 0
    for (const [key, item] of this.items) {
      if (item.userId !== userId) continue
      if (item.expiresAt > now) count += 1
      this.items.delete(key)
    }
    return count
  }

  async hasPending(userId: string, now: Date): Promise<boolean> {
    return [...this.items.values()].some((i) => i.userId === userId && i.expiresAt > now)
  }
}

interface PendingActionDocument {
  _id: ObjectId
  userId: string
  kind: PendingActionKind
  payload: Record<string, string>
  summary: string
  createdAt: Date
  expiresAt: Date
}

/** Persistencia en identity_db. El índice TTL borra las caducadas; las consultas también las filtran. */
export class MongoPendingActions implements PendingActionStore {
  private readonly collection: Collection<PendingActionDocument>

  constructor(db: Db) {
    this.collection = db.collection<PendingActionDocument>('lumi_pending_actions')
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'lumi_pending_actions_ttl' })
    await this.collection.createIndex({ userId: 1, kind: 1 }, { unique: true, name: 'lumi_pending_actions_user_kind' })
  }

  async put(action: Omit<PendingAction, 'id'>): Promise<PendingAction> {
    // Una sola acción pendiente por (usuario, tipo): la nueva sustituye a la anterior.
    const result = await this.collection.findOneAndUpdate(
      { userId: action.userId, kind: action.kind },
      { $set: { ...action } },
      { upsert: true, returnDocument: 'after' },
    )
    return { ...action, id: (result?._id ?? new ObjectId()).toHexString() }
  }

  async take(userId: string, kind: PendingActionKind, now: Date, id?: string): Promise<PendingAction | null> {
    if (id !== undefined && !ObjectId.isValid(id)) return null
    const doc = await this.collection.findOneAndDelete({
      userId,
      kind,
      expiresAt: { $gt: now },
      ...(id !== undefined ? { _id: new ObjectId(id) } : {}),
    })
    if (!doc) return null
    const { _id, ...rest } = doc
    return { ...rest, id: _id.toHexString() }
  }

  async discard(userId: string, now: Date): Promise<number> {
    const live = await this.collection.countDocuments({ userId, expiresAt: { $gt: now } })
    await this.collection.deleteMany({ userId })
    return live
  }

  async hasPending(userId: string, now: Date): Promise<boolean> {
    return (await this.collection.countDocuments({ userId, expiresAt: { $gt: now } }, { limit: 1 })) > 0
  }
}

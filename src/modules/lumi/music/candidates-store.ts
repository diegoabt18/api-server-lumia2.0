import type { Redis } from 'ioredis'
import type { LumiMusicSelection } from '../tools/tool.types.js'

interface StoredSelection {
  userId: string
  selection: LumiMusicSelection
}

const KEY = (queryId: string) => `lumi:music:candidates:${queryId}`
const LOCK_KEY = (queryId: string) => `lumi:music:selection-lock:${queryId}`
/** Tope de una reproducción en curso; el agente responde (o caduca) antes. */
const LOCK_SECONDS = 90

/**
 * Búsquedas de música que esperan la elección del usuario. Redis con caducidad propia; sin Redis
 * (o si falla), memoria del proceso. Cada búsqueda pertenece a un usuario y solo él la usa.
 */
export class MusicCandidatesStore {
  private readonly memory = new Map<string, StoredSelection>()
  private readonly memoryLocks = new Map<string, number>()

  constructor(private readonly redis: Redis | null) {}

  async store(userId: string, selection: LumiMusicSelection): Promise<void> {
    const seconds = Math.max(1, Math.ceil((Date.parse(selection.expiresAt) - Date.now()) / 1000))
    const entry: StoredSelection = { userId, selection }
    if (this.redis) {
      try {
        await this.redis.set(KEY(selection.queryId), JSON.stringify(entry), 'EX', seconds)
        return
      } catch {
        // Sin Redis la búsqueda sigue en memoria de este proceso.
      }
    }
    this.prune()
    this.memory.set(selection.queryId, entry)
  }

  /** La búsqueda vigente de ese usuario, o null (no existe, caducó o es de otro usuario). */
  async retrieve(userId: string, queryId: string): Promise<LumiMusicSelection | null> {
    let entry: StoredSelection | null = this.memory.get(queryId) ?? null
    if (!entry && this.redis) {
      try {
        const raw = await this.redis.get(KEY(queryId))
        entry = raw ? (JSON.parse(raw) as StoredSelection) : null
      } catch {
        entry = null
      }
    }
    if (!entry || entry.userId !== userId) return null
    if (Date.parse(entry.selection.expiresAt) <= Date.now()) return null
    return entry.selection
  }

  /** Reserva la búsqueda para una sola reproducción a la vez. false si ya hay una en curso. */
  async lock(queryId: string): Promise<boolean> {
    if (this.redis) {
      try {
        return (await this.redis.set(LOCK_KEY(queryId), '1', 'EX', LOCK_SECONDS, 'NX')) === 'OK'
      } catch {
        // Cae al bloqueo en memoria.
      }
    }
    const until = this.memoryLocks.get(queryId)
    if (until && until > Date.now()) return false
    this.memoryLocks.set(queryId, Date.now() + LOCK_SECONDS * 1000)
    return true
  }

  async unlock(queryId: string): Promise<void> {
    this.memoryLocks.delete(queryId)
    if (!this.redis) return
    try {
      await this.redis.del(LOCK_KEY(queryId))
    } catch {
      // El bloqueo caduca solo.
    }
  }

  private prune(): void {
    const now = Date.now()
    for (const [queryId, entry] of this.memory) {
      if (Date.parse(entry.selection.expiresAt) <= now) this.memory.delete(queryId)
    }
  }
}

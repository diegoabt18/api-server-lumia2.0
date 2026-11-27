import type { Redis } from 'ioredis'
import type { LumiMusicSelection } from '../tools/tool.types.js'
import type { MusicPlaybackState } from './playback-state.js'

/** Reproducción ya hecha de un candidato: un segundo clic la devuelve sin repetirla. */
export interface StoredPlayback {
  status: 'playing' | 'partial'
  state: MusicPlaybackState | null
  message: string
}

interface StoredSelection {
  userId: string
  selection: LumiMusicSelection
}

const KEY = (queryId: string) => `lumi:music:candidates:${queryId}`
const LOCK_KEY = (queryId: string) => `lumi:music:selection-lock:${queryId}`
const RESULT_KEY = (queryId: string, candidateId: string) =>
  `lumi:music:selection-result:${queryId}:${candidateId}`
/** Tope de una reproducción en curso; el agente responde (o caduca) antes. */
const LOCK_SECONDS = 90

/**
 * Búsquedas de música que esperan la elección del usuario. Redis con caducidad propia; sin Redis
 * (o si falla), memoria del proceso. Cada búsqueda pertenece a un usuario y solo él la usa.
 */
export class MusicCandidatesStore {
  private readonly memory = new Map<string, StoredSelection>()
  private readonly memoryLocks = new Map<string, number>()
  private readonly memoryResults = new Map<string, { until: number; playback: StoredPlayback }>()

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

  /** Fija la conversación en la que se mostró la tarjeta (solo si aún no tenía una). */
  async attachConversation(userId: string, queryId: string, conversationId: string): Promise<void> {
    const selection = await this.retrieve(userId, queryId)
    if (!selection || selection.conversationId) return
    await this.store(userId, { ...selection, conversationId })
  }

  /** Guarda una reproducción que funcionó, mientras la búsqueda siga vigente. */
  async rememberPlayback(
    selection: LumiMusicSelection,
    candidateId: string,
    playback: StoredPlayback,
  ): Promise<void> {
    const until = Date.parse(selection.expiresAt)
    const seconds = Math.max(1, Math.ceil((until - Date.now()) / 1000))
    const key = RESULT_KEY(selection.queryId, candidateId)
    if (this.redis) {
      try {
        await this.redis.set(key, JSON.stringify(playback), 'EX', seconds)
        return
      } catch {
        // Cae a memoria.
      }
    }
    this.memoryResults.set(key, { until, playback })
  }

  async recallPlayback(queryId: string, candidateId: string): Promise<StoredPlayback | null> {
    const key = RESULT_KEY(queryId, candidateId)
    const local = this.memoryResults.get(key)
    if (local) {
      if (local.until > Date.now()) return local.playback
      this.memoryResults.delete(key)
    }
    if (!this.redis) return null
    try {
      const raw = await this.redis.get(key)
      return raw ? (JSON.parse(raw) as StoredPlayback) : null
    } catch {
      return null
    }
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
    for (const [key, entry] of this.memoryResults) {
      if (entry.until <= now) this.memoryResults.delete(key)
    }
  }
}

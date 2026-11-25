import type { Redis } from 'ioredis'

export interface MusicCandidate {
  id: string // YouTube video ID
  title: string
  artist: string
  duration: number // seconds
  thumbnailUrl: string | null
  type: 'song' | 'live' | 'cover' | 'remix' | 'official' | 'unknown'
}

export interface CandidatesEntry {
  queryId: string
  query: string
  candidates: MusicCandidate[]
  expiresAt: Date
}

/**
 * Almacena candidatos de música con caché Redis y fallback en memoria.
 * TTL configurable (default 10 minutos).
 */
export class MusicCandidatesStore {
  private readonly redis: Redis | null
  private readonly memoryCache = new Map<string, CandidatesEntry>()
  private readonly ttlSeconds: number

  constructor(redis: Redis | null, ttlSeconds = 600) {
    this.redis = redis
    this.ttlSeconds = ttlSeconds
  }

  /**
   * Almacena candidatos con un queryId (UUID).
   * Retorna el queryId y fecha de expiración.
   */
  async store(
    queryId: string,
    query: string,
    candidates: MusicCandidate[],
  ): Promise<{ queryId: string; expiresAt: Date }> {
    const expiresAt = new Date(Date.now() + this.ttlSeconds * 1000)
    const entry: CandidatesEntry = { queryId, query, candidates, expiresAt }

    if (this.redis) {
      try {
        await this.redis.setex(
          `lumi:music:candidates:${queryId}`,
          this.ttlSeconds,
          JSON.stringify(entry),
        )
      } catch (err) {
        // Fallback a memoria si Redis falla
        console.warn('Redis storage failed, using memory fallback', { err })
        this.memoryCache.set(queryId, entry)
      }
    } else {
      this.memoryCache.set(queryId, entry)
    }

    return { queryId, expiresAt }
  }

  /**
   * Recupera candidatos por queryId.
   * Retorna null si no existen o si han expirado.
   */
  async retrieve(queryId: string): Promise<CandidatesEntry | null> {
    if (this.redis) {
      try {
        const cached = await this.redis.getex(
          `lumi:music:candidates:${queryId}`,
          'EX',
          this.ttlSeconds,
        )
        if (cached) {
          return JSON.parse(cached) as CandidatesEntry
        }
      } catch (err) {
        console.warn('Redis retrieval failed', { err })
      }
    }

    // Fallback a memoria
    const entry = this.memoryCache.get(queryId)
    if (entry && entry.expiresAt > new Date()) {
      return entry
    }

    // Limpiar entrada expirada
    this.memoryCache.delete(queryId)
    return null
  }

  /**
   * Elimina candidatos (ej. después de seleccionar uno).
   */
  async delete(queryId: string): Promise<void> {
    if (this.redis) {
      try {
        await this.redis.del(`lumi:music:candidates:${queryId}`)
      } catch (err) {
        console.warn('Redis delete failed', { err })
      }
    }
    this.memoryCache.delete(queryId)
  }

  /**
   * Limpia entradas expiradas de memoria (opera localmente).
   */
  cleanupExpired(): void {
    const now = new Date()
    for (const [queryId, entry] of this.memoryCache.entries()) {
      if (entry.expiresAt <= now) {
        this.memoryCache.delete(queryId)
      }
    }
  }
}

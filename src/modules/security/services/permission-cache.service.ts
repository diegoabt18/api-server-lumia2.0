import type { CacheService } from '../../../database/connections/redis.manager.js'

const PREFIX = 'perm:'
const DEFAULT_TTL = 300

interface CacheStats {
  hits: number
  misses: number
  invalidations: number
}

export type { CacheStats }

export class PermissionCacheService {
  private stats: CacheStats = { hits: 0, misses: 0, invalidations: 0 }
  private readonly memory = new Map<string, { value: string; expiresAt: number }>()

  constructor(private readonly cache: CacheService) {}

  private key(userId: string): string {
    return `${PREFIX}${userId}`
  }

  async get(userId: string): Promise<string[] | null> {
    const raw = await this.cache.get(this.key(userId))
    if (raw) {
      this.stats.hits++
      try {
        return JSON.parse(raw) as string[]
      } catch {
        return null
      }
    }
    const mem = this.memory.get(userId)
    if (mem && Date.now() < mem.expiresAt) {
      this.stats.hits++
      try {
        return JSON.parse(mem.value) as string[]
      } catch {
        return null
      }
    }
    this.stats.misses++
    return null
  }

  async set(userId: string, keys: string[], ttlSeconds = DEFAULT_TTL): Promise<void> {
    const value = JSON.stringify(keys)
    await this.cache.set(this.key(userId), value, ttlSeconds)
    this.memory.set(userId, { value, expiresAt: Date.now() + ttlSeconds * 1000 })
  }

  async invalidate(userId?: string): Promise<number> {
    if (userId) {
      await this.cache.del(this.key(userId))
      this.memory.delete(userId)
      this.stats.invalidations++
      return 1
    }
    let count = 0
    for (const k of [...this.memory.keys()]) {
      await this.cache.del(this.key(k))
      this.memory.delete(k)
      count++
    }
    this.stats.invalidations += count
    return count
  }

  prune(): number {
    const now = Date.now()
    let pruned = 0
    for (const [k, v] of this.memory.entries()) {
      if (now > v.expiresAt) {
        this.memory.delete(k)
        pruned++
      }
    }
    return pruned
  }

  resetStats(): CacheStats {
    this.stats = { hits: 0, misses: 0, invalidations: 0 }
    return { ...this.stats }
  }

  getStats(): CacheStats & { memoryEntries: number } {
    return { ...this.stats, memoryEntries: this.memory.size }
  }
}

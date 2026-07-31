import { Redis } from 'ioredis'
import type { AppLogger } from '../../config/logger.js'
import { getEnv } from '../../config/env.js'

export type RedisClient = Redis | null

export class RedisManager {
  private client: Redis | null = null
  private available = false
  private readonly logger: AppLogger

  constructor(logger: AppLogger) {
    this.logger = logger
  }

  async connect(): Promise<RedisClient> {
    const env = getEnv()
    if (!env.REDIS_ENABLED || !env.REDIS_URL) {
      this.logger.warn('Redis disabled or REDIS_URL not set — running without cache/rate-limit store')
      return null
    }

    let client: Redis | null = null
    try {
      client = new Redis(env.REDIS_URL, {
        maxRetriesPerRequest: 1,
        lazyConnect: true,
        connectTimeout: 3000,
        retryStrategy: () => null,
        enableOfflineQueue: false,
      })
      client.on('error', () => {
        /* evita Unhandled error event cuando Redis no está disponible */
      })
      await client.connect()
      this.client = client
      this.available = true
      this.logger.info('Redis connected')
      return this.client
    } catch (err) {
      this.logger.warn({ err }, 'Redis unavailable — degrading gracefully')
      client?.disconnect()
      this.client = null
      this.available = false
      return null
    }
  }

  getClient(): RedisClient {
    return this.available ? this.client : null
  }

  isAvailable(): boolean {
    return this.available
  }

  async ping(): Promise<boolean> {
    if (!this.client || !this.available) return false
    try {
      const result = await this.client.ping()
      return result === 'PONG'
    } catch {
      return false
    }
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.quit().catch(() => {})
      this.client = null
      this.available = false
    }
  }
}

/** Cache simple con fallback en memoria cuando Redis no está disponible. */
export class CacheService {
  private readonly memory = new Map<string, { value: string; expiresAt: number }>()

  constructor(private readonly redis: RedisClient) {}

  async get(key: string): Promise<string | null> {
    if (this.redis) {
      try {
        return await this.redis.get(key)
      } catch {
        /* fallback memory */
      }
    }
    const entry = this.memory.get(key)
    if (!entry) return null
    if (Date.now() > entry.expiresAt) {
      this.memory.delete(key)
      return null
    }
    return entry.value
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (this.redis) {
      try {
        await this.redis.setex(key, ttlSeconds, value)
        return
      } catch {
        /* fallback memory */
      }
    }
    this.memory.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 })
  }

  async del(key: string): Promise<void> {
    if (this.redis) {
      try {
        await this.redis.del(key)
      } catch {
        /* ignore */
      }
    }
    this.memory.delete(key)
  }
}

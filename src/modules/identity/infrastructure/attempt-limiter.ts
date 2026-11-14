import { createHash } from 'node:crypto'
import type { RedisClient } from '../../../database/connections/redis.manager.js'

export interface AttemptLimiterOptions {
  /** Redis key prefix, e.g. `auth:login:`. */
  prefix: string
  /** Failures allowed inside the window before the subject is blocked. */
  maxFailures: number
  windowSeconds: number
}

const MEMORY_PRUNE_EVERY = 500

export const TOO_MANY_ATTEMPTS_MESSAGE =
  'Demasiados intentos fallidos. Espera unos minutos antes de volver a intentarlo.'

/**
 * Counts failed attempts per subject (an email, a user id) in a fixed window.
 *
 * It is keyed by account, not by IP: Lumia 2.0 reaches the API from the Cloudflare Worker
 * egress IPs and X-Forwarded-For can be forged, so an IP key would either block every
 * customer at once or be trivially bypassed. Subjects are hashed before use as keys.
 *
 * Uses Redis when available (shared between instances, survives restarts) and an in-memory
 * map otherwise or when a Redis command fails.
 */
export class AttemptLimiter {
  private readonly memory = new Map<string, { count: number; expiresAt: number }>()
  private writes = 0

  constructor(
    private readonly redis: RedisClient,
    private readonly options: AttemptLimiterOptions,
  ) {}

  private key(subject: string): string {
    const digest = createHash('sha256').update(subject.trim().toLowerCase()).digest('hex')
    return `${this.options.prefix}${digest.slice(0, 32)}`
  }

  async isBlocked(subject: string): Promise<boolean> {
    return (await this.failures(subject)) >= this.options.maxFailures
  }

  async failures(subject: string): Promise<number> {
    const key = this.key(subject)
    if (this.redis) {
      try {
        return Number((await this.redis.get(key)) ?? 0)
      } catch {
        /* memory fallback */
      }
    }
    const entry = this.memory.get(key)
    if (!entry) return 0
    if (entry.expiresAt <= Date.now()) {
      this.memory.delete(key)
      return 0
    }
    return entry.count
  }

  /** Registers a failure and returns the failures counted in the current window. */
  async registerFailure(subject: string): Promise<number> {
    const key = this.key(subject)
    if (this.redis) {
      try {
        const count = await this.redis.incr(key)
        if (count === 1) await this.redis.expire(key, this.options.windowSeconds)
        return count
      } catch {
        /* memory fallback */
      }
    }
    const now = Date.now()
    this.pruneMemory(now)
    const entry = this.memory.get(key)
    if (!entry || entry.expiresAt <= now) {
      this.memory.set(key, { count: 1, expiresAt: now + this.options.windowSeconds * 1000 })
      return 1
    }
    entry.count += 1
    return entry.count
  }

  async reset(subject: string): Promise<void> {
    const key = this.key(subject)
    this.memory.delete(key)
    if (this.redis) {
      try {
        await this.redis.del(key)
      } catch {
        /* ignore */
      }
    }
  }

  private pruneMemory(now: number): void {
    this.writes += 1
    if (this.writes % MEMORY_PRUNE_EVERY !== 0) return
    for (const [key, entry] of this.memory) {
      if (entry.expiresAt <= now) this.memory.delete(key)
    }
  }
}

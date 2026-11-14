import bcrypt from 'bcryptjs'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { loadEnv, parseTrustProxy } from '../../src/config/env.js'
import { AttemptLimiter } from '../../src/modules/identity/infrastructure/attempt-limiter.js'
import { AuthService } from '../../src/modules/identity/services/auth.service.js'

beforeAll(() => {
  loadEnv({
    NODE_ENV: 'test',
    MONGO_AUTH_URI: 'mongodb://localhost/identity',
    MONGO_CATALOG_URI: 'mongodb://localhost/catalog',
    MONGO_SALES_URI: 'mongodb://localhost/sales',
    MONGO_PRODUCTION_URI: 'mongodb://localhost/production',
    JWT_SECRET: 'test-secret-at-least-16-chars',
    AUTH_LOCAL_ENABLED: 'true',
  })
})

describe('AttemptLimiter (memory fallback)', () => {
  it('blocks after maxFailures and resets', async () => {
    const limiter = new AttemptLimiter(null, { prefix: 't:', maxFailures: 3, windowSeconds: 60 })
    expect(await limiter.isBlocked('A@Example.com')).toBe(false)
    await limiter.registerFailure('a@example.com')
    await limiter.registerFailure('A@EXAMPLE.COM ')
    expect(await limiter.isBlocked('a@example.com')).toBe(false)
    await limiter.registerFailure('a@example.com')
    // El email se normaliza: mayúsculas y espacios cuentan como la misma cuenta.
    expect(await limiter.isBlocked('A@example.com')).toBe(true)
    await limiter.reset('a@example.com')
    expect(await limiter.isBlocked('a@example.com')).toBe(false)
  })

  it('expires the window', async () => {
    vi.useFakeTimers()
    try {
      const limiter = new AttemptLimiter(null, { prefix: 't:', maxFailures: 1, windowSeconds: 60 })
      await limiter.registerFailure('u1')
      expect(await limiter.isBlocked('u1')).toBe(true)
      vi.advanceTimersByTime(61_000)
      expect(await limiter.isBlocked('u1')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('falls back to memory when Redis fails', async () => {
    const broken = {
      get: async () => {
        throw new Error('down')
      },
      incr: async () => {
        throw new Error('down')
      },
      expire: async () => 0,
      del: async () => 0,
    }
    const limiter = new AttemptLimiter(broken as never, {
      prefix: 't:',
      maxFailures: 1,
      windowSeconds: 60,
    })
    await limiter.registerFailure('u1')
    expect(await limiter.isBlocked('u1')).toBe(true)
  })
})

describe('AuthService.login throttling', () => {
  async function setup(maxFailures = 3) {
    const passwordHash = await bcrypt.hash('correct-password', 4)
    const user = { _id: 'u1', email: 'a@example.com', passwordHash }
    const users = { findByEmail: vi.fn(async (email: string) => (email === user.email ? user : null)) }
    const audit = { log: vi.fn(async () => {}) }
    const limiter = new AttemptLimiter(null, { prefix: 't:', maxFailures, windowSeconds: 60 })
    const twoFactor = {
      isTwoFactorEnabled: () => true,
      createLoginTempToken: () => 'temp',
    }
    const svc = new AuthService(
      users as never,
      {} as never,
      {} as never,
      audit as never,
      twoFactor as never,
      undefined,
      limiter,
    )
    return { svc, users, audit, limiter }
  }

  it('locks the account after repeated wrong passwords, before running bcrypt', async () => {
    const { svc, users } = await setup(3)
    for (let i = 0; i < 3; i++) {
      await expect(svc.login({ email: 'a@example.com', password: 'nope' })).rejects.toMatchObject({
        statusCode: 401,
      })
    }
    users.findByEmail.mockClear()
    await expect(
      svc.login({ email: 'a@example.com', password: 'correct-password' }),
    ).rejects.toMatchObject({ statusCode: 429, code: 'TOO_MANY_ATTEMPTS' })
    expect(users.findByEmail).not.toHaveBeenCalled()
  })

  it('counts unknown emails too (no account enumeration by lockout behaviour)', async () => {
    const { svc } = await setup(2)
    await expect(svc.login({ email: 'ghost@example.com', password: 'x' })).rejects.toMatchObject({
      statusCode: 401,
    })
    await expect(svc.login({ email: 'ghost@example.com', password: 'x' })).rejects.toMatchObject({
      statusCode: 401,
    })
    await expect(svc.login({ email: 'ghost@example.com', password: 'x' })).rejects.toMatchObject({
      statusCode: 429,
    })
  })

  it('resets the counter after a correct password', async () => {
    const { svc, limiter } = await setup(3)
    await expect(svc.login({ email: 'a@example.com', password: 'nope' })).rejects.toBeTruthy()
    await expect(svc.login({ email: 'a@example.com', password: 'nope' })).rejects.toBeTruthy()
    const result = await svc.login({ email: 'a@example.com', password: 'correct-password' })
    expect(result).toMatchObject({ requires2fa: true })
    expect(await limiter.failures('a@example.com')).toBe(0)
  })
})

describe('parseTrustProxy', () => {
  it('keeps the previous default (trust all)', () => {
    expect(parseTrustProxy('true')).toBe(true)
    expect(parseTrustProxy('')).toBe(true)
  })
  it('accepts false, hop counts and CIDR lists', () => {
    expect(parseTrustProxy('false')).toBe(false)
    const oneHop = parseTrustProxy('1') as (address: string, hop: number) => boolean
    expect(typeof oneHop).toBe('function')
    expect(oneHop('10.0.0.1', 0)).toBe(true)
    expect(oneHop('10.0.0.1', 1)).toBe(false)
    expect(parseTrustProxy('127.0.0.1, 172.18.0.0/16')).toEqual(['127.0.0.1', '172.18.0.0/16'])
  })
})

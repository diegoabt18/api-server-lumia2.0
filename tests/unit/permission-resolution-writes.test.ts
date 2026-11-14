import { describe, expect, it, vi } from 'vitest'
import {
  AuthorizationService,
  PERMISSION_CACHE_TTL_SECONDS,
} from '../../src/modules/security/services/authorization.service.js'
import { SecurityMaintenance } from '../../src/modules/security/services/security-maintenance.js'

function setup(opts: { temporalExpiresInMs?: number } = {}) {
  const temporal = {
    expireAllOverdue: vi.fn(async () => 2),
    findActiveByUserId: vi.fn(async () =>
      opts.temporalExpiresInMs === undefined
        ? []
        : [{ permissionKeys: ['orders.read'], expiresAt: new Date(Date.now() + opts.temporalExpiresInMs) }],
    ),
  }
  const delegations = { expireAllOverdue: vi.fn(async () => 1), findActiveByUserId: vi.fn(async () => []) }
  const cache = { get: vi.fn(async () => null), set: vi.fn(async () => {}) }
  const svc = new AuthorizationService(
    { findByIds: async () => [], findByIdSafe: async () => null } as never,
    { findByUserId: async () => [] } as never,
    temporal as never,
    { findActiveByUserId: async () => [] } as never,
    delegations as never,
    { listActive: async () => [] } as never,
    cache as never,
  )
  return { svc, temporal, delegations, cache }
}

describe('permission resolution has no writes (P6)', () => {
  it('does not run expireAllOverdue while resolving', async () => {
    const { svc, temporal, delegations } = setup({ temporalExpiresInMs: 60_000 })
    expect(await svc.resolveEffectivePermissions('u1')).toEqual(['orders.read'])
    expect(temporal.expireAllOverdue).not.toHaveBeenCalled()
    expect(delegations.expireAllOverdue).not.toHaveBeenCalled()
  })

  it('caps the cache TTL at the first grant expiry', async () => {
    const { svc, cache } = setup({ temporalExpiresInMs: 42_000 })
    await svc.resolveEffectivePermissions('u1')
    const ttl = (cache.set.mock.calls[0] as unknown[])[2] as number
    expect(ttl).toBeGreaterThanOrEqual(41)
    expect(ttl).toBeLessThanOrEqual(42)
  })

  it('keeps the default TTL without expiring grants', async () => {
    const { svc, cache } = setup()
    await svc.resolveEffectivePermissions('u1')
    expect((cache.set.mock.calls[0] as unknown[])[2]).toBe(PERMISSION_CACHE_TTL_SECONDS)
  })

  it('expires overdue grants in the maintenance task', async () => {
    const { svc, temporal, delegations } = setup()
    expect(await svc.expireOverdueGrants()).toEqual({ temporal: 2, delegations: 1 })
    expect(temporal.expireAllOverdue).toHaveBeenCalledTimes(1)
    expect(delegations.expireAllOverdue).toHaveBeenCalledTimes(1)
  })
})

describe('SecurityMaintenance', () => {
  it('does not overlap runs and reports errors', async () => {
    let release!: () => void
    const task = vi.fn(() => new Promise<void>((r) => (release = r)))
    const onError = vi.fn()
    const m = new SecurityMaintenance(task, 1000, onError)
    const first = m.tick()
    expect(await m.tick()).toBe(false)
    release()
    expect(await first).toBe(true)

    const failing = new SecurityMaintenance(async () => {
      throw new Error('boom')
    }, 1000, onError)
    expect(await failing.tick()).toBe(false)
    expect(onError).toHaveBeenCalledTimes(1)
  })
})

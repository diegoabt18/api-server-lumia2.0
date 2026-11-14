import { describe, expect, it, vi } from 'vitest'
import { ALL_PERMISSION_IDS } from '../../src/common/permissions/registry.js'
import {
  assertCanGrant,
  assertNotSelf,
  effectiveAllow,
  findUngrantable,
} from '../../src/modules/security/domain/grant-guard.js'
import { SecurityAdminService } from '../../src/modules/security/services/security-admin.service.js'
import { SecurityEnterpriseService } from '../../src/modules/security/services/security-enterprise.service.js'

const limited = { userId: 'actor', permissionKeys: ['admin.access', 'admin.users.manage', 'orders.read'] }
const superAdmin = { userId: 'root', permissionKeys: [...ALL_PERMISSION_IDS] }

describe('grant guard (pure)', () => {
  it('allows granting permissions the actor holds', () => {
    expect(findUngrantable(limited.permissionKeys, ['orders.read'])).toEqual([])
  })

  it('rejects permissions the actor does not hold', () => {
    expect(findUngrantable(limited.permissionKeys, ['orders.read', 'products.update'])).toEqual([
      'products.update',
    ])
  })

  it('treats * as every permission', () => {
    expect(findUngrantable(limited.permissionKeys, ['*'])).toEqual(['*'])
    expect(findUngrantable(superAdmin.permissionKeys, ['*'])).toEqual([])
    expect(findUngrantable(['*'], ['*', 'products.update'])).toEqual([])
  })

  it('ignores keys that are not registry permissions (they grant nothing)', () => {
    expect(findUngrantable(limited.permissionKeys, ['not.a.permission'])).toEqual([])
  })

  it('throws 403 PRIVILEGE_ESCALATION with the missing permissions', () => {
    try {
      assertCanGrant(limited, ['products.update'])
      throw new Error('expected rejection')
    } catch (err) {
      expect(err).toMatchObject({
        statusCode: 403,
        code: 'PRIVILEGE_ESCALATION',
        details: { permissions: ['products.update'] },
      })
    }
  })

  it('blocks self changes', () => {
    expect(() => assertNotSelf(limited, 'actor')).toThrowError(
      expect.objectContaining({ code: 'SELF_PERMISSION_CHANGE' }),
    )
    expect(() => assertNotSelf(limited, 'someone-else')).not.toThrow()
  })

  it('computes effective allow minus deny', () => {
    expect(effectiveAllow(['orders.read', 'products.read'], ['products.read'])).toEqual([
      'orders.read',
    ])
    expect(effectiveAllow(['*']).length).toBe(ALL_PERMISSION_IDS.length)
  })
})

type Role = {
  _id: string
  key: string
  name: string
  permissionKeys: string[]
  denyKeys?: string[]
  inheritRoleIds?: string[]
  isArchived?: boolean
}

function adminService(roles: Role[]) {
  const assign = vi.fn(async (userId: string, roleId: string) => ({ _id: 'a1', userId, roleId }))
  const update = vi.fn(async (id: string, patch: Partial<Role>) => {
    const role = roles.find((r) => r._id === id)
    return role ? { ...role, ...patch } : null
  })
  const invalidateUserCache = vi.fn(async () => {})
  const invalidateAllCaches = vi.fn(async () => {})
  const svc = new SecurityAdminService(
    {
      findByIdSafe: async (id: string) => roles.find((r) => r._id === id) ?? null,
      findByKey: async () => null,
      update,
      create: async (data: Partial<Role>) => ({ _id: 'new', ...data }),
      toDomain: (r: Role) => r,
    } as never,
    { assign, remove: async () => true } as never,
    { findByIdSafe: async (id: string) => ({ _id: id }) } as never,
    {
      listPermissions: async () => ALL_PERMISSION_IDS.map((key) => ({ key })),
    } as never,
    {
      resolveEffectivePermissions: async () => [],
      invalidateUserCache,
      invalidateAllCaches,
    } as never,
  )
  return { svc, assign, update, invalidateUserCache, invalidateAllCaches }
}

describe('SecurityAdminService escalation checks', () => {
  const roles: Role[] = [
    { _id: 'r-orders', key: 'orders', name: 'Orders', permissionKeys: ['orders.read'] },
    { _id: 'r-super', key: 'super', name: 'Super', permissionKeys: ['*'] },
    {
      _id: 'r-child',
      key: 'child',
      name: 'Child',
      permissionKeys: ['orders.read'],
      inheritRoleIds: ['r-super'],
    },
  ]

  it('rejects assigning a role to oneself', async () => {
    const { svc, assign } = adminService(roles)
    await expect(svc.assignRole('actor', 'r-orders', limited)).rejects.toMatchObject({
      code: 'SELF_PERMISSION_CHANGE',
    })
    expect(assign).not.toHaveBeenCalled()
  })

  it('rejects assigning a role with permissions the actor lacks (wildcard)', async () => {
    const { svc, assign } = adminService(roles)
    await expect(svc.assignRole('victim', 'r-super', limited)).rejects.toMatchObject({
      code: 'PRIVILEGE_ESCALATION',
    })
    expect(assign).not.toHaveBeenCalled()
  })

  it('rejects assigning a role that inherits permissions the actor lacks', async () => {
    const { svc } = adminService(roles)
    await expect(svc.assignRole('victim', 'r-child', limited)).rejects.toMatchObject({
      code: 'PRIVILEGE_ESCALATION',
    })
  })

  it('assigns a role within the actor permissions and invalidates the target cache', async () => {
    const { svc, assign, invalidateUserCache } = adminService(roles)
    await svc.assignRole('victim', 'r-orders', limited)
    expect(assign).toHaveBeenCalledWith('victim', 'r-orders', 'actor')
    expect(invalidateUserCache).toHaveBeenCalledWith('victim')
  })

  it('rejects editing a role to add permissions the actor lacks', async () => {
    const { svc, update } = adminService(roles)
    await expect(
      svc.updateRole('r-orders', { permissionKeys: ['orders.read', 'products.update'] }, limited),
    ).rejects.toMatchObject({ code: 'PRIVILEGE_ESCALATION' })
    expect(update).not.toHaveBeenCalled()
  })

  it('allows removing permissions and invalidates every cache', async () => {
    const { svc, update, invalidateAllCaches } = adminService([
      { _id: 'r-x', key: 'x', name: 'X', permissionKeys: ['orders.read', 'products.update'] },
    ])
    await svc.updateRole('r-x', { permissionKeys: ['orders.read'] }, limited)
    expect(update).toHaveBeenCalled()
    expect(invalidateAllCaches).toHaveBeenCalled()
  })

  it('rejects creating a role with permissions the actor lacks', async () => {
    const { svc } = adminService([])
    await expect(
      svc.createRole({ key: 'k', name: 'K', permissionKeys: ['products.update'] }, limited),
    ).rejects.toMatchObject({ code: 'PRIVILEGE_ESCALATION' })
  })

  it('lets a full administrator grant anything', async () => {
    const { svc, assign } = adminService(roles)
    await svc.assignRole('victim', 'r-super', superAdmin)
    expect(assign).toHaveBeenCalled()
  })
})

describe('SecurityEnterpriseService escalation checks', () => {
  function enterprise() {
    const temporalCreate = vi.fn()
    const overrideCreate = vi.fn()
    const svc = new SecurityEnterpriseService(
      { findByIdSafe: async () => null } as never, // roles
      {} as never, // userRoles
      {} as never, // users
      {} as never, // registry
      { invalidateUserCache: async () => {}, invalidateAllCaches: async () => {} } as never,
      { create: temporalCreate } as never, // temporal
      { create: overrideCreate } as never, // overrides
      {} as never, // delegations
      {} as never, // templates
      {} as never, // conditional
      {} as never, // approvals
      {} as never, // scheduled
      { append: async () => {} } as never, // permAudit
      {} as never, // webhooks
      {} as never, // authAudit
      {} as never, // sessions
      {} as never, // permCache
    )
    return { svc, temporalCreate, overrideCreate }
  }

  it('rejects temporal grants of permissions the actor lacks', async () => {
    const { svc, temporalCreate } = enterprise()
    await expect(
      svc.grantTemporal(
        {
          userId: 'victim',
          permissionKeys: ['*'],
          reason: 'x',
          startsAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 1000).toISOString(),
        },
        limited,
      ),
    ).rejects.toMatchObject({ code: 'PRIVILEGE_ESCALATION' })
    expect(temporalCreate).not.toHaveBeenCalled()
  })

  it('rejects overrides granted to oneself', async () => {
    const { svc, overrideCreate } = enterprise()
    await expect(
      svc.grantOverride({ userId: 'actor', permissionKeys: ['orders.read'], reason: 'x' }, limited),
    ).rejects.toMatchObject({ code: 'SELF_PERMISSION_CHANGE' })
    expect(overrideCreate).not.toHaveBeenCalled()
  })
})

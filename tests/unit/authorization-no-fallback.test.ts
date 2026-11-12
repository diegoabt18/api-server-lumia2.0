import { describe, expect, it } from 'vitest'
import { AuthorizationService } from '../../src/modules/security/services/authorization.service.js'

/** Repositorios falsos: solo lo que usa resolveEffectivePermissions. */
function service(opts: {
  assignments: Array<{ roleId: string }>
  roles?: Array<{
    _id: string
    permissionKeys: string[]
    denyKeys?: string[]
    isArchived?: boolean
  }>
}) {
  const roles = opts.roles ?? []
  return new AuthorizationService(
    {
      findByIds: async (ids: string[]) => roles.filter((r) => ids.includes(r._id)),
      findByIdSafe: async (id: string) => roles.find((r) => r._id === id) ?? null,
    } as never,
    { findByUserId: async () => opts.assignments } as never,
  )
}

describe('resolveEffectivePermissions sin respaldo por rol base', () => {
  it('no concede permisos a un admin sin roles RBAC', async () => {
    const svc = service({ assignments: [] })
    expect(await svc.resolveEffectivePermissions('u1')).toEqual([])
  })

  it('no concede permisos si los roles asignados ya no existen', async () => {
    const svc = service({ assignments: [{ roleId: 'r-borrado' }] })
    expect(await svc.resolveEffectivePermissions('u1')).toEqual([])
  })

  it('no concede permisos si el rol asignado solo deniega', async () => {
    const svc = service({
      assignments: [{ roleId: 'r1' }],
      roles: [{ _id: 'r1', permissionKeys: ['orders.read'], denyKeys: ['orders.read'] }],
    })
    expect(await svc.resolveEffectivePermissions('u1')).toEqual([])
  })

  it('usa solo los permisos del rol RBAC asignado', async () => {
    const svc = service({
      assignments: [{ roleId: 'customer' }],
      roles: [{ _id: 'customer', permissionKeys: ['cart.read', 'orders.read'] }],
    })
    const keys = await svc.resolveEffectivePermissions('u1')
    expect([...keys].sort()).toEqual(['cart.read', 'orders.read'])
  })
})

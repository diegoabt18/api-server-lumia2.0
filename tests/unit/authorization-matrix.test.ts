import { describe, it, expect } from 'vitest'
import {
  PERMISSION_REGISTRY,
  PERMISSION_WILDCARD,
  hasPermission,
  isPermissionId,
  resolvePermissionsForRole,
  type PermissionId,
} from '../../src/common/permissions/registry.js'

const P = PERMISSION_REGISTRY

/** Conjuntos efectivos típicos. En producción los asigna la base de datos (roles de identity_db). */
const profiles: Record<string, PermissionId[]> = {
  cliente: resolvePermissionsForRole('user'),
  moderador: resolvePermissionsForRole('moderator'),
  admin: resolvePermissionsForRole('admin'),
  // Personal de POS: solo ventas y lectura de catálogo.
  posStaff: [P.ORDERS_CREATE, P.ORDERS_UPDATE, P.ORDERS_READ, P.PAYMENTS_CREATE, P.CART_READ, P.PRODUCTS_READ],
  // Producción: materiales y costeo, sin acceso a pedidos ni a seguridad.
  produccion: [P.MATERIALS_UPDATE, P.MATERIALS_READ, P.COSTING_MANAGE, P.PRODUCTS_READ, P.ADMIN_ACCESS],
  superadmin: [PERMISSION_WILDCARD as PermissionId],
}

const can = (profile: string, permission: PermissionId) => hasPermission(profiles[profile]!, permission)

describe('static role baselines', () => {
  it('cliente cannot enter the administration area', () => {
    expect(can('cliente', P.ADMIN_ACCESS)).toBe(false)
    expect(can('cliente', P.PRODUCTS_UPDATE)).toBe(false)
  })

  it('moderador enters admin and edits products but cannot delete them', () => {
    expect(can('moderador', P.ADMIN_ACCESS)).toBe(true)
    expect(can('moderador', P.PRODUCTS_UPDATE)).toBe(true)
    expect(can('moderador', P.PRODUCTS_DELETE)).toBe(false)
  })

  it('admin holds every registered permission', () => {
    for (const id of Object.values(P)) expect(can('admin', id)).toBe(true)
  })
})

describe('fine-grained profiles', () => {
  it('POS staff can record sales and payments but not administer products or orders', () => {
    expect(can('posStaff', P.ORDERS_CREATE)).toBe(true)
    expect(can('posStaff', P.PAYMENTS_CREATE)).toBe(true)
    expect(can('posStaff', P.ADMIN_ACCESS)).toBe(false)
    expect(can('posStaff', P.PRODUCTS_UPDATE)).toBe(false)
  })

  it('production staff manages materials and costing but not sales or security', () => {
    expect(can('produccion', P.MATERIALS_UPDATE)).toBe(true)
    expect(can('produccion', P.COSTING_MANAGE)).toBe(true)
    expect(can('produccion', P.ORDERS_UPDATE)).toBe(false)
    expect(can('produccion', P.ADMIN_SECURITY_MANAGE)).toBe(false)
  })

  it('superadmin wildcard grants any permission, including ones added later', () => {
    expect(can('superadmin', P.ADMIN_PERMISSIONS_MANAGE)).toBe(true)
    expect(hasPermission([PERMISSION_WILDCARD as PermissionId], 'permiso.futuro' as PermissionId)).toBe(true)
  })
})

describe('permission identifiers', () => {
  it('accepts only registered permission identifiers', () => {
    expect(isPermissionId(P.PRODUCTS_UPDATE)).toBe(true)
    expect(isPermissionId('products.update; DROP')).toBe(false)
    expect(isPermissionId('')).toBe(false)
    expect(isPermissionId(undefined)).toBe(false)
    expect(isPermissionId({ $ne: null })).toBe(false)
  })
})

describe('production unit-conversion routes stay protected', () => {
  it('every unit-conversion route declares an admin guard', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../../src/routes/production-public.routes.ts', import.meta.url), 'utf8')
    const calls = [...src.matchAll(/api\.(get|post)\(\s*'(\/production\/unit-conversion[^']*)'[\s\S]*?\n {2}\}\)/g)]
    expect(calls.length).toBe(4)
    for (const call of calls) expect(call[0]).toMatch(/preHandler: g\(PERMISSION_REGISTRY\./)
  })
})

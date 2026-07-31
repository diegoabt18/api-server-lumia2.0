import { describe, it, expect } from 'vitest'
import {
  generatePermissionHash,
  resolvePermissionsForRole,
  hasPermission,
  PERMISSION_REGISTRY,
} from '../../src/common/permissions/registry.js'
import { buildPaginationMeta, resolvePagingQuery } from '../../src/common/utils/pagination.js'
import { AppError, isAppError } from '../../src/common/errors/app.error.js'

describe('permissions registry', () => {
  it('generates stable permission hash', () => {
    const keys = resolvePermissionsForRole('user')
    const h1 = generatePermissionHash(keys)
    const h2 = generatePermissionHash(keys)
    expect(h1).toBe(h2)
    expect(h1.startsWith('ph_')).toBe(true)
  })

  it('admin has all permissions', () => {
    const keys = resolvePermissionsForRole('admin')
    expect(hasPermission(keys, PERMISSION_REGISTRY.ADMIN_ACCESS)).toBe(true)
    expect(hasPermission(keys, PERMISSION_REGISTRY.PRODUCTS_DELETE)).toBe(true)
  })

  it('user cannot delete products', () => {
    const keys = resolvePermissionsForRole('user')
    expect(hasPermission(keys, PERMISSION_REGISTRY.PRODUCTS_READ)).toBe(true)
    expect(hasPermission(keys, PERMISSION_REGISTRY.PRODUCTS_DELETE)).toBe(false)
  })
})

describe('pagination', () => {
  it('resolves paging query defaults', () => {
    const result = resolvePagingQuery({})
    expect(result.page).toBe(1)
    expect(result.limit).toBe(20)
    expect(result.skip).toBe(0)
  })

  it('builds pagination meta', () => {
    const meta = buildPaginationMeta(45, 2, 20)
    expect(meta.totalPages).toBe(3)
    expect(meta.hasNext).toBe(true)
    expect(meta.hasPrev).toBe(true)
  })
})

describe('AppError', () => {
  it('identifies app errors', () => {
    const err = AppError.notFound('x')
    expect(isAppError(err)).toBe(true)
    expect(err.statusCode).toBe(404)
  })
})

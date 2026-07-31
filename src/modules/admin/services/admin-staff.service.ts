import { AppError } from '../../../common/errors/app.error.js'
import { buildPaginationMeta, resolvePagingQuery } from '../../../common/utils/pagination.js'
import {
  buildAuthzSnapshot,
  resolvePermissionsForRole,
} from '../../../common/permissions/registry.js'
import type { UserRepository } from '../../identity/infrastructure/user.repository.js'
import type { UserRole } from '../../../common/permissions/registry.js'

export class AdminStaffService {
  constructor(private readonly users: UserRepository) {}

  async list(query: Record<string, unknown>) {
    const qParam = typeof query.q === 'string' ? query.q : ''
    const sParam = typeof query.search === 'string' ? query.search : ''
    const combinedSearch = (sParam || qParam).trim()
    const { page, limit, skip, search } = resolvePagingQuery(
      { ...query, search: combinedSearch || undefined },
      { defaultLimit: 30, maxLimit: 100 },
    )
    const { items, total } = await this.users.listStaff(skip, limit, search || undefined)
    const mapped = items.map((u) => ({
      id: u._id,
      email: u.email,
      name: u.name ?? null,
      role: u.role,
      isStaff: !!u.isStaff,
      permissionsVersion: u.permissionsVersion ?? 1,
      permissionUpdatedAt: u.permissionUpdatedAt?.toISOString?.() ?? null,
      createdAt: u.createdAt?.toISOString?.() ?? null,
    }))
    return { total, items: mapped, pagination: buildPaginationMeta(total, page, limit) }
  }

  async get(id: string) {
    const user = await this.users.findStaffById(id)
    if (!user) throw AppError.notFound('Usuario staff no encontrado')
    const snap = buildAuthzSnapshot(user.role)
    return {
      user: {
        id: user._id,
        email: user.email,
        name: user.name ?? null,
        role: user.role,
        isStaff: !!user.isStaff,
        permissionsVersion: user.permissionsVersion ?? 1,
        permissionUpdatedAt: user.permissionUpdatedAt?.toISOString?.() ?? null,
        createdAt: user.createdAt?.toISOString?.() ?? null,
      },
      roles: [{ id: user.role, name: user.role, key: user.role }],
      effectivePermissionKeys: snap.permissionKeys,
      permHash: snap.permHash,
    }
  }

  async updateRole(id: string, role: UserRole) {
    const allowed: UserRole[] = ['admin', 'moderator', 'user']
    if (!allowed.includes(role)) throw AppError.badRequest('Rol no válido')
    const updated = await this.users.updateStaffRole(id, role)
    if (!updated) throw AppError.notFound('Usuario staff no encontrado')
    const snap = buildAuthzSnapshot(updated.role)
    return {
      ok: true,
      user: {
        id: updated._id,
        email: updated.email,
        role: updated.role,
        effectivePermissionKeys: resolvePermissionsForRole(updated.role),
        permHash: snap.permHash,
      },
    }
  }

  async removeRole(id: string) {
    return this.updateRole(id, 'user')
  }
}

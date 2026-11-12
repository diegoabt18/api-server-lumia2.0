import type { AuthorizationService } from '../../security/services/authorization.service.js'
import type { RoleRepository } from '../../security/infrastructure/role.repository.js'
import type { UserRoleRepository } from '../../security/infrastructure/user-role.repository.js'
import { AppError } from '../../../common/errors/app.error.js'
import { buildPaginationMeta, resolvePagingQuery } from '../../../common/utils/pagination.js'
import { buildAuthzSnapshot } from '../../../common/permissions/registry.js'
import type { UserRepository } from '../../identity/infrastructure/user.repository.js'

export class AdminStaffService {
  constructor(
    private readonly users: UserRepository,
    private readonly authorization: AuthorizationService,
    private readonly roles: RoleRepository,
    private readonly userRoles: UserRoleRepository,
  ) {}

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
    const snap = buildAuthzSnapshot(await this.authorization.resolveEffectivePermissions(user._id!))
    // Roles RBAC reales (user_roles).
    const assignments = await this.userRoles.findByUserId(user._id!)
    const roleDocs = await this.roles.findByIds(assignments.map((a) => a.roleId))
    return {
      user: {
        id: user._id,
        email: user.email,
        name: user.name ?? null,
        isStaff: !!user.isStaff,
        permissionsVersion: user.permissionsVersion ?? 1,
        permissionUpdatedAt: user.permissionUpdatedAt?.toISOString?.() ?? null,
        createdAt: user.createdAt?.toISOString?.() ?? null,
      },
      roles: roleDocs.map((r) => ({ id: r._id, name: r.name, key: r.key })),
      effectivePermissionKeys: snap.permissionKeys,
      permHash: snap.permHash,
    }
  }
}

import { AppError } from '../../../common/errors/app.error.js'
import {
  ALL_PERMISSION_IDS,
  expandPermissions,
  type UserRole,
} from '../../../common/permissions/registry.js'
import { buildPaginationMeta, resolvePagingQuery } from '../../../common/utils/pagination.js'
import type { RegistryRepository } from '../../admin/infrastructure/registry.repository.js'
import type { UserRepository } from '../../identity/infrastructure/user.repository.js'
import type { RoleEntity } from '../domain/role.entity.js'
import type { RoleRepository } from '../infrastructure/role.repository.js'
import type { UserRoleRepository } from '../infrastructure/user-role.repository.js'
import type { AuthorizationService } from './authorization.service.js'

export class SecurityAdminService {
  constructor(
    private readonly roles: RoleRepository,
    private readonly userRoles: UserRoleRepository,
    private readonly users: UserRepository,
    private readonly registry: RegistryRepository,
    private readonly authorization: AuthorizationService,
  ) {}

  async listRoles() {
    const items = await this.roles.list()
    return { items: items.map((r) => this.roles.toDomain(r)) }
  }

  async getRole(id: string) {
    const role = await this.roles.findByIdSafe(id)
    if (!role) throw AppError.notFound('Rol no encontrado')
    return { role: this.roles.toDomain(role) }
  }

  async createRole(body: {
    key: string
    name: string
    description?: string
    permissionKeys: string[]
  }) {
    const key = body.key.trim()
    if (!key) throw AppError.badRequest('key es requerido')
    const existing = await this.roles.findByKey(key)
    if (existing) throw AppError.conflict('Ya existe un rol con esa key')

    const permissionKeys = expandPermissions(body.permissionKeys)
    const role = await this.roles.create({
      key,
      name: body.name.trim(),
      description: body.description?.trim(),
      permissionKeys,
    })
    return { role: this.roles.toDomain(role) }
  }

  async updateRole(
    id: string,
    patch: { name?: string; description?: string; permissionKeys?: string[] },
  ) {
    const update: Partial<Pick<RoleEntity, 'name' | 'description' | 'permissionKeys'>> = {}
    if (patch.name !== undefined) update.name = patch.name.trim()
    if (patch.description !== undefined) update.description = patch.description.trim()
    if (patch.permissionKeys !== undefined) {
      update.permissionKeys = expandPermissions(patch.permissionKeys)
    }

    try {
      const updated = await this.roles.update(id, update)
      if (!updated) throw AppError.notFound('Rol no encontrado')
      return { role: this.roles.toDomain(updated) }
    } catch (err) {
      if (err instanceof Error && err.message === 'SYSTEM_ROLE_IMMUTABLE') {
        throw AppError.forbidden('Los roles de sistema no pueden modificarse')
      }
      throw err
    }
  }

  async deleteRole(id: string) {
    const ok = await this.roles.delete(id)
    if (!ok) throw AppError.notFound('Rol no encontrado o es de sistema')
    return { ok: true }
  }

  async listPermissions() {
    const dbPermissions = await this.registry.listPermissions()
    const byKey = new Map(dbPermissions.map((p) => [p.key, p]))

    const items = ALL_PERMISSION_IDS.map((key) => {
      const fromDb = byKey.get(key)
      return {
        key,
        name: fromDb?.name ?? key,
        description: fromDb?.description ?? `Permiso ${key}`,
        moduleKey: fromDb?.moduleKey ?? null,
        type: fromDb?.type ?? 'admin',
        isActive: fromDb?.isActive ?? true,
        inRegistry: !!fromDb,
      }
    })

    return { items, total: items.length }
  }

  async listUsers(query: Record<string, unknown>) {
    const staffOnly = query.staffOnly === 'true' || query.staffOnly === true
    const qParam = typeof query.q === 'string' ? query.q : ''
    const sParam = typeof query.search === 'string' ? query.search : ''
    const combinedSearch = (sParam || qParam).trim()
    const { page, limit, skip, search } = resolvePagingQuery(
      { ...query, search: combinedSearch || undefined },
      { defaultLimit: 30, maxLimit: 100 },
    )

    const { items, total } = await this.users.listForSecurity(skip, limit, {
      staffOnly,
      search: search || undefined,
    })

    const mapped = await Promise.all(
      items.map(async (u) => {
        const assignments = await this.userRoles.findByUserId(u._id!)
        const roleDocs = await this.roles.findByIds(assignments.map((a) => a.roleId))
        const effectiveKeys = await this.authorization.resolveEffectivePermissions(
          u._id!,
          u.role as UserRole,
        )
        return {
          id: u._id,
          email: u.email,
          name: u.name ?? null,
          role: u.role,
          isStaff: !!u.isStaff,
          twoFactorEnabled: !!u.twoFactor?.enabled,
          assignedRoles: roleDocs.map((r) => this.roles.toDomain(r)),
          effectivePermissionCount: effectiveKeys.length,
          permissionsVersion: u.permissionsVersion ?? 1,
          createdAt: u.createdAt?.toISOString?.() ?? null,
        }
      }),
    )

    return { total, items: mapped, pagination: buildPaginationMeta(total, page, limit) }
  }

  async getUser(id: string) {
    const user = await this.users.findByIdSafe(id)
    if (!user) throw AppError.notFound('Usuario no encontrado')

    const assignments = await this.userRoles.findByUserId(id)
    const roleDocs = await this.roles.findByIds(assignments.map((a) => a.roleId))
    const effectivePermissionKeys = await this.authorization.resolveEffectivePermissions(
      id,
      user.role as UserRole,
    )
    const snap = await this.authorization.buildAuthzSnapshot(
      id,
      user.role as UserRole,
      user.permissionsVersion ?? 1,
    )

    return {
      user: {
        id: user._id,
        email: user.email,
        name: user.name ?? null,
        role: user.role,
        isStaff: !!user.isStaff,
        twoFactorEnabled: !!user.twoFactor?.enabled,
        permissionsVersion: user.permissionsVersion ?? 1,
        permissionUpdatedAt: user.permissionUpdatedAt?.toISOString?.() ?? null,
        createdAt: user.createdAt?.toISOString?.() ?? null,
      },
      roles: roleDocs.map((r) => this.roles.toDomain(r)),
      effectivePermissionKeys,
      permHash: snap.permHash,
    }
  }

  async assignRole(userId: string, roleId: string, assignedBy?: string) {
    const user = await this.users.findByIdSafe(userId)
    if (!user) throw AppError.notFound('Usuario no encontrado')
    const role = await this.roles.findByIdSafe(roleId)
    if (!role) throw AppError.notFound('Rol no encontrado')

    const assignment = await this.userRoles.assign(userId, roleId, assignedBy)
    const effectivePermissionKeys = await this.authorization.resolveEffectivePermissions(
      userId,
      user.role as UserRole,
    )

    return {
      ok: true,
      assignment: {
        id: assignment._id,
        userId: assignment.userId,
        roleId: assignment.roleId,
        role: this.roles.toDomain(role),
      },
      effectivePermissionKeys,
    }
  }

  async removeRole(userId: string, roleId: string) {
    const user = await this.users.findByIdSafe(userId)
    if (!user) throw AppError.notFound('Usuario no encontrado')
    const ok = await this.userRoles.remove(userId, roleId)
    if (!ok) throw AppError.notFound('Asignación no encontrada')

    const effectivePermissionKeys = await this.authorization.resolveEffectivePermissions(
      userId,
      user.role as UserRole,
    )
    return { ok: true, effectivePermissionKeys }
  }
}

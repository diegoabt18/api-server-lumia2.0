import { AppError } from '../../../common/errors/app.error.js'
import {
  ALL_PERMISSION_IDS,
  expandPermissions,
  PERMISSION_REGISTRY,
  type PermissionId,
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

  async exportRoles() {
    const items = await this.roles.list(true)
    return {
      exportedAt: new Date().toISOString(),
      items: items.map((r) => this.roles.toDomain(r)),
    }
  }

  async importRoles(
    data: { roles: Array<{ key: string; name: string; description?: string; permissionKeys?: string[] }> },
  ) {
    let created = 0
    let updated = 0
    for (const r of data.roles ?? []) {
      const existing = await this.roles.findByKey(r.key)
      const permissionKeys = expandPermissions(r.permissionKeys ?? [])
      if (existing) {
        await this.roles.update(existing._id!, {
          name: r.name,
          description: r.description,
          permissionKeys,
        })
        updated++
      } else {
        await this.roles.create({
          key: r.key,
          name: r.name,
          description: r.description,
          permissionKeys,
        })
        created++
      }
    }
    return { created, updated }
  }

  async archiveRole(id: string) {
    if (!(await this.roles.archive(id))) throw AppError.notFound('Rol no encontrado o es de sistema')
    return { ok: true }
  }

  async restoreRole(id: string) {
    if (!(await this.roles.restore(id))) throw AppError.notFound('Rol archivado no encontrado')
    return { ok: true }
  }

  async duplicateRole(id: string, body: { key: string; name: string }) {
    const role = await this.roles.duplicate(id, body.key, body.name)
    if (!role) throw AppError.notFound('Rol origen no encontrado')
    return { role: this.roles.toDomain(role) }
  }

  async getEffectiveRole(id: string) {
    const role = await this.roles.findByIdSafe(id)
    if (!role) throw AppError.notFound('Rol no encontrado')
    const inherited = await this.resolveRoleEffectiveKeys(role)
    const deny = expandPermissions(role.denyKeys ?? [])
    const allow = new Set([...expandPermissions(role.permissionKeys), ...inherited])
    for (const d of deny) allow.delete(d)
    return {
      roleId: id,
      allow: [...allow],
      deny,
      inheritedFrom: role.inheritRoleIds ?? [],
    }
  }

  private async resolveRoleEffectiveKeys(
    role: RoleEntity,
    visited = new Set<string>(),
  ): Promise<PermissionId[]> {
    if (!role._id || visited.has(role._id)) return []
    visited.add(role._id)
    const keys: PermissionId[] = []
    for (const parentId of role.inheritRoleIds ?? []) {
      const parent = await this.roles.findByIdSafe(parentId)
      if (!parent || parent.isArchived) continue
      keys.push(...expandPermissions(parent.permissionKeys))
      keys.push(...(await this.resolveRoleEffectiveKeys(parent, visited)))
    }
    return keys
  }

  async getInheritanceGraph() {
    const roles = await this.roles.list(true)
    const nodes = roles.map((r) => ({ id: r._id, key: r.key, name: r.name }))
    const edges = roles.flatMap((r) =>
      (r.inheritRoleIds ?? []).map((parentId) => ({
        from: parentId,
        to: r._id,
      })),
    )
    return { nodes, edges }
  }

  async validateInheritance(body: { inheritRoleIds: string[]; roleId?: string }) {
    const visited = new Set<string>()
    const errors: string[] = []
    const walk = async (id: string, chain: string[]): Promise<void> => {
      if (chain.includes(id)) {
        errors.push(`Ciclo detectado: ${[...chain, id].join(' -> ')}`)
        return
      }
      if (visited.has(id)) return
      visited.add(id)
      const role = await this.roles.findByIdSafe(id)
      if (!role) {
        errors.push(`Rol heredado no encontrado: ${id}`)
        return
      }
      for (const parentId of role.inheritRoleIds ?? []) {
        await walk(parentId, [...chain, id])
      }
    }
    for (const id of body.inheritRoleIds) {
      await walk(id, body.roleId ? [body.roleId] : [])
    }
    return { valid: errors.length === 0, errors }
  }

  async getPermission(key: string) {
    const fromDb = await this.registry.findPermissionByKey(key)
    const inRegistry = ALL_PERMISSION_IDS.includes(key as PermissionId)
    if (!fromDb && !inRegistry) throw AppError.notFound('Permiso no encontrado')
    return {
      permission: {
        key,
        name: fromDb?.name ?? key,
        description: fromDb?.description ?? `Permiso ${key}`,
        moduleKey: fromDb?.moduleKey ?? null,
        type: fromDb?.type ?? 'admin',
        isActive: fromDb?.isActive ?? true,
        inRegistry,
      },
    }
  }

  async createPermission(body: {
    key: string
    name: string
    description?: string
    moduleKey?: string
    type?: string
  }) {
    if (await this.registry.findPermissionByKey(body.key)) {
      throw AppError.conflict('El permiso ya existe')
    }
    const seed = {
      key: body.key,
      name: body.name,
      description: body.description ?? '',
      moduleKey: body.moduleKey ?? 'custom',
      type: body.type ?? 'admin',
      isActive: true,
    }
    await this.registry.createPermission(seed as never)
    return { permission: seed }
  }

  async patchPermission(
    key: string,
    patch: { name?: string; description?: string; isActive?: boolean; moduleKey?: string },
  ) {
    const updated = await this.registry.updatePermission(key, patch as never)
    if (!updated) throw AppError.notFound('Permiso no encontrado')
    return { permission: updated }
  }

  async syncPermissions() {
    const seeds = ALL_PERMISSION_IDS.map((key) => ({
      key,
      name: key,
      description: `Permiso ${key}`,
      moduleKey: key.split('.')[0] ?? 'core',
      type: 'admin' as const,
      isActive: true,
    }))
    return this.registry.syncPermissions(seeds as never)
  }

  async permissionsHealth() {
    const dbPermissions = await this.registry.listPermissions()
    const dbKeys = new Set(dbPermissions.map((p) => p.key))
    const missingInDb = ALL_PERMISSION_IDS.filter((k) => !dbKeys.has(k))
    const inactive = dbPermissions.filter((p) => p.isActive === false)
    const critical = [
      PERMISSION_REGISTRY.ADMIN_ACCESS,
      PERMISSION_REGISTRY.ADMIN_SECURITY_MANAGE,
      PERMISSION_REGISTRY.ADMIN_ROLES_MANAGE,
    ].filter((k) => !dbKeys.has(k) || inactive.some((p) => p.key === k))
    return {
      totalRegistry: ALL_PERMISSION_IDS.length,
      totalInDb: dbPermissions.length,
      missingInDb: missingInDb.length,
      inactiveCount: inactive.length,
      criticalIssues: critical,
      healthy: critical.length === 0 && missingInDb.length === 0,
    }
  }

  async bulkAssignRoles(body: {
    userIds: string[]
    roleId: string
    assignedBy: string
  }) {
    const role = await this.roles.findByIdSafe(body.roleId)
    if (!role) throw AppError.notFound('Rol no encontrado')
    const results = []
    for (const userId of body.userIds) {
      try {
        await this.assignRole(userId, body.roleId, body.assignedBy)
        results.push({ userId, ok: true })
      } catch (err) {
        results.push({
          userId,
          ok: false,
          error: err instanceof Error ? err.message : 'Error',
        })
      }
    }
    return {
      total: body.userIds.length,
      succeeded: results.filter((r) => r.ok).length,
      results,
    }
  }
}

import {
  expandPermissions,
  generatePermissionHash,
  type PermissionId,
} from '../../../common/permissions/registry.js'
import type { RoleRepository } from '../infrastructure/role.repository.js'
import type { UserRoleRepository } from '../infrastructure/user-role.repository.js'
import type { TemporalPermissionRepository } from '../infrastructure/temporal-permission.repository.js'
import type { UserPermissionOverrideRepository } from '../infrastructure/user-permission-override.repository.js'
import type { RoleDelegationRepository } from '../infrastructure/role-delegation.repository.js'
import type { ConditionalPermissionRepository } from '../infrastructure/conditional-permission.repository.js'
import type { PermissionCacheService } from './permission-cache.service.js'
import { ConditionEvaluationEngine, type ConditionContext } from './conditional-evaluation.js'

export type PermissionResolverContext = Partial<ConditionContext>

export class AuthorizationService {
  constructor(
    private readonly roles: RoleRepository,
    private readonly userRoles: UserRoleRepository,
    private readonly temporal?: TemporalPermissionRepository,
    private readonly overrides?: UserPermissionOverrideRepository,
    private readonly delegations?: RoleDelegationRepository,
    private readonly conditional?: ConditionalPermissionRepository,
    private readonly permCache?: PermissionCacheService,
  ) {}

  async resolveEffectivePermissions(
    userId: string,
    ctx?: PermissionResolverContext,
  ): Promise<PermissionId[]> {
    const cached = this.permCache ? await this.permCache.get(userId) : null
    if (cached) return expandPermissions(cached)

    const base = await this.resolveRoleBasedPermissions(userId)
    const extra = await this.resolveExtraPermissions(userId, ctx)
    const merged = new Set<PermissionId>([...base, ...extra])
    const result = [...merged]

    if (this.permCache) await this.permCache.set(userId, result)
    return result
  }

  /**
   * Los permisos salen solo de los roles RBAC asignados (user_roles). Sin roles o sin permisos
   * efectivos no hay acceso: el rol base de users.role NO concede permisos.
   */
  private async resolveRoleBasedPermissions(userId: string): Promise<PermissionId[]> {
    const assignments = await this.userRoles.findByUserId(userId)
    if (!assignments.length) return []

    const roleIds = assignments.map((a) => a.roleId)
    const roleDocs = await this.roles.findByIds(roleIds)
    if (!roleDocs.length) return []

    const allow = new Set<PermissionId>()
    const deny = new Set<PermissionId>()

    for (const role of roleDocs) {
      if (role.isArchived) continue
      const inherited = await this.resolveInheritedPermissions(role._id!, role.inheritRoleIds ?? [])
      for (const key of expandPermissions([...role.permissionKeys, ...inherited])) {
        allow.add(key)
      }
      for (const key of expandPermissions(role.denyKeys ?? [])) {
        deny.add(key)
      }
    }

    for (const d of deny) allow.delete(d)
    if (allow.size === 0) return []
    return [...allow]
  }

  private async resolveInheritedPermissions(
    roleId: string,
    inheritRoleIds: string[],
    visited = new Set<string>(),
  ): Promise<PermissionId[]> {
    if (visited.has(roleId)) return []
    visited.add(roleId)
    const keys: PermissionId[] = []
    for (const parentId of inheritRoleIds) {
      if (visited.has(parentId)) continue
      const parent = await this.roles.findByIdSafe(parentId)
      if (!parent || parent.isArchived) continue
      keys.push(...expandPermissions(parent.permissionKeys))
      if (parent.inheritRoleIds?.length) {
        keys.push(
          ...(await this.resolveInheritedPermissions(parentId, parent.inheritRoleIds, visited)),
        )
      }
    }
    return keys
  }

  private async resolveExtraPermissions(
    userId: string,
    ctx?: PermissionResolverContext,
  ): Promise<PermissionId[]> {
    const merged = new Set<PermissionId>()

    if (this.temporal) {
      try {
        await this.temporal.expireAllOverdue()
        for (const p of await this.temporal.findActiveByUserId(userId)) {
          for (const k of p.permissionKeys) merged.add(k)
        }
      } catch {
        /* non-critical */
      }
    }

    if (this.delegations) {
      try {
        await this.delegations.expireAllOverdue()
        for (const d of await this.delegations.findActiveByUserId(userId)) {
          const role = await this.roles.findByIdSafe(d.roleId)
          if (role) {
            for (const k of expandPermissions(role.permissionKeys)) merged.add(k)
          }
        }
      } catch {
        /* non-critical */
      }
    }

    if (this.overrides) {
      for (const o of await this.overrides.findActiveByUserId(userId)) {
        for (const k of o.permissionKeys) merged.add(k)
      }
    }

    if (this.conditional) {
      try {
        const active = await this.conditional.listActive()
        const context: ConditionContext = {
          currentTime: ctx?.currentTime ?? new Date(),
          userId,
          userAttributes: ctx?.userAttributes ?? {},
          ip: ctx?.ip ?? null,
        }
        for (const k of ConditionEvaluationEngine.evaluate(active, context)) {
          merged.add(k as PermissionId)
        }
      } catch {
        /* non-critical */
      }
    }

    return [...merged]
  }

  async buildAuthzSnapshot(
    userId: string,
    permissionsVersion = 1,
    ctx?: PermissionResolverContext,
  ) {
    const permissionKeys = await this.resolveEffectivePermissions(userId, ctx)
    return {
      permissionKeys,
      permHash: generatePermissionHash(permissionKeys),
      permissionsVersion,
      permissionUpdatedAt: new Date(),
    }
  }

  async explainPermissions(userId: string) {
    const roleBased = await this.resolveRoleBasedPermissions(userId)
    const temporal = this.temporal
      ? (await this.temporal.findActiveByUserId(userId)).flatMap((p) => p.permissionKeys)
      : []
    const overrides = this.overrides
      ? (await this.overrides.findActiveByUserId(userId)).flatMap((o) => o.permissionKeys)
      : []
    const delegations = this.delegations
      ? await Promise.all(
          (await this.delegations.findActiveByUserId(userId)).map(async (d) => {
            const role = await this.roles.findByIdSafe(d.roleId)
            return {
              delegationId: d._id,
              roleId: d.roleId,
              keys: role ? expandPermissions(role.permissionKeys) : [],
            }
          }),
        )
      : []
    const effective = await this.resolveEffectivePermissions(userId)
    return {
      userId,
      sources: {
        roleBased,
        temporal,
        overrides,
        delegations,
      },
      effective,
      effectiveCount: effective.length,
    }
  }

  async invalidateUserCache(userId: string): Promise<void> {
    if (this.permCache) await this.permCache.invalidate(userId)
  }
}

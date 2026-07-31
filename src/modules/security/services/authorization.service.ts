import {
  expandPermissions,
  generatePermissionHash,
  resolvePermissionsForRole,
  type PermissionId,
  type UserRole,
} from '../../../common/permissions/registry.js'
import type { RoleRepository } from '../infrastructure/role.repository.js'
import type { UserRoleRepository } from '../infrastructure/user-role.repository.js'

export class AuthorizationService {
  constructor(
    private readonly roles: RoleRepository,
    private readonly userRoles: UserRoleRepository,
  ) {}

  async resolveEffectivePermissions(userId: string, fallbackRole: UserRole): Promise<PermissionId[]> {
    const assignments = await this.userRoles.findByUserId(userId)
    if (!assignments.length) {
      return resolvePermissionsForRole(fallbackRole)
    }

    const roleIds = assignments.map((a) => a.roleId)
    const roleDocs = await this.roles.findByIds(roleIds)
    if (!roleDocs.length) {
      return resolvePermissionsForRole(fallbackRole)
    }

    const merged = new Set<PermissionId>()
    for (const role of roleDocs) {
      for (const key of expandPermissions(role.permissionKeys)) {
        merged.add(key)
      }
    }

    if (merged.size === 0) {
      return resolvePermissionsForRole(fallbackRole)
    }

    return [...merged]
  }

  async buildAuthzSnapshot(userId: string, role: UserRole, permissionsVersion = 1) {
    const permissionKeys = await this.resolveEffectivePermissions(userId, role)
    return {
      permissionKeys,
      permHash: generatePermissionHash(permissionKeys),
      permissionsVersion,
      permissionUpdatedAt: new Date(),
    }
  }
}

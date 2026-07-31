import type { PermissionId } from '../../../common/permissions/registry.js'

export interface RoleEntity {
  _id?: string
  key: string
  name: string
  description?: string
  permissionKeys: PermissionId[]
  denyKeys?: PermissionId[]
  inheritRoleIds?: string[]
  isSystem?: boolean
  isArchived?: boolean
  archivedAt?: Date | null
  version?: number
  createdAt?: Date
  updatedAt?: Date
}

export interface UserRoleAssignment {
  _id?: string
  userId: string
  roleId: string
  assignedAt?: Date
  assignedBy?: string | null
}

export interface RoleDomain {
  id: string
  key: string
  name: string
  description?: string
  permissionKeys: PermissionId[]
  denyKeys: PermissionId[]
  inheritRoleIds: string[]
  isSystem: boolean
  isArchived: boolean
  archivedAt?: string | null
  version: number
  createdAt?: string
  updatedAt?: string
}

export function toRoleDomain(entity: RoleEntity): RoleDomain {
  return {
    id: entity._id!,
    key: entity.key,
    name: entity.name,
    description: entity.description,
    permissionKeys: entity.permissionKeys,
    denyKeys: entity.denyKeys ?? [],
    inheritRoleIds: entity.inheritRoleIds ?? [],
    isSystem: !!entity.isSystem,
    isArchived: !!entity.isArchived,
    archivedAt: entity.archivedAt?.toISOString?.() ?? null,
    version: entity.version ?? 1,
    createdAt: entity.createdAt?.toISOString(),
    updatedAt: entity.updatedAt?.toISOString(),
  }
}

import type { PermissionId } from '../../../common/permissions/registry.js'

export interface RoleEntity {
  _id?: string
  key: string
  name: string
  description?: string
  permissionKeys: PermissionId[]
  isSystem?: boolean
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
  isSystem: boolean
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
    isSystem: !!entity.isSystem,
    createdAt: entity.createdAt?.toISOString(),
    updatedAt: entity.updatedAt?.toISOString(),
  }
}

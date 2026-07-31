import { z } from 'zod'

export const twoFactorCodeSchema = z.object({
  code: z.string().min(6).max(8),
})

export const twoFactorVerifyLoginSchema = z.object({
  tempToken: z.string().min(1),
  code: z.string().min(6).max(8),
})

export const twoFactorAdminUserSchema = z.object({
  userId: z.string().min(1).optional(),
})

export const roleCreateSchema = z.object({
  key: z.string().min(2).max(64),
  name: z.string().min(2).max(120),
  description: z.string().max(500).optional(),
  permissionKeys: z.array(z.string()).default([]),
  denyKeys: z.array(z.string()).optional(),
  inheritRoleIds: z.array(z.string()).optional(),
})

export const rolePatchSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  description: z.string().max(500).optional(),
  permissionKeys: z.array(z.string()).optional(),
  denyKeys: z.array(z.string()).optional(),
  inheritRoleIds: z.array(z.string()).optional(),
})

export const roleDuplicateSchema = z.object({
  key: z.string().min(2).max(64),
  name: z.string().min(2).max(120),
})

export const roleImportSchema = z.object({
  roles: z.array(
    z.object({
      key: z.string().min(2),
      name: z.string().min(2),
      description: z.string().optional(),
      permissionKeys: z.array(z.string()).default([]),
    }),
  ),
})

export const validateInheritanceSchema = z.object({
  inheritRoleIds: z.array(z.string()),
  roleId: z.string().optional(),
})

export const assignRoleSchema = z.object({
  roleId: z.string().min(1),
})

export const bulkRolesSchema = z.object({
  userIds: z.array(z.string().min(1)).min(1),
  roleId: z.string().min(1),
})

export const permissionCreateSchema = z.object({
  key: z.string().min(2).max(120),
  name: z.string().min(2).max(120),
  description: z.string().max(500).optional(),
  moduleKey: z.string().optional(),
  type: z.string().optional(),
})

export const permissionPatchSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  description: z.string().max(500).optional(),
  isActive: z.boolean().optional(),
  moduleKey: z.string().optional(),
})

export const temporalGrantSchema = z.object({
  userId: z.string().min(1),
  permissionKeys: z.array(z.string()).min(1),
  reason: z.string().min(1).max(500),
  startsAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
})

export const temporalRevokeSchema = z.object({
  id: z.string().min(1),
})

export const overrideGrantSchema = z.object({
  userId: z.string().min(1),
  permissionKeys: z.array(z.string()).min(1),
  reason: z.string().min(1).max(500),
})

export const delegationSchema = z.object({
  userId: z.string().min(1),
  roleId: z.string().min(1),
  reason: z.string().min(1).max(500),
  startsAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
})

export const templateCreateSchema = z.object({
  name: z.string().min(2).max(120),
  description: z.string().max(500).optional(),
  permissionKeys: z.array(z.string()).default([]),
  category: z.string().optional(),
  color: z.string().optional(),
  icon: z.string().optional(),
})

export const templateApplySchema = z.object({
  templateId: z.string().min(1),
  roleId: z.string().min(1),
})

export const conditionClauseSchema = z.object({
  type: z.enum(['time_range', 'user_attribute', 'ip_range', 'day_of_week']),
  config: z.record(z.unknown()),
})

export const conditionalCreateSchema = z.object({
  name: z.string().min(2).max(120),
  description: z.string().max(500).optional(),
  permissionKeys: z.array(z.string()).min(1),
  conditions: z.array(conditionClauseSchema).min(1),
  logic: z.enum(['AND', 'OR']).optional(),
  priority: z.number().optional(),
  appliesToUserId: z.string().nullable().optional(),
})

export const approvalActionSchema = z.object({
  id: z.string().min(1),
  reason: z.string().optional(),
})

export const approvalCreateSchema = z.object({
  action: z.string().min(1),
  payload: z.record(z.unknown()).default({}),
  summary: z.string().min(1),
  risk: z.enum(['low', 'medium', 'high']).optional(),
})

export const scheduledChangeSchema = z.object({
  action: z.string().min(1),
  payload: z.record(z.unknown()).default({}),
  summary: z.string().min(1),
  executeAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
})

export const webhookCreateSchema = z.object({
  name: z.string().min(2).max(120),
  url: z.string().url(),
  secret: z.string().optional(),
  events: z.array(z.string()).min(1),
})

export const webhookUpdateSchema = webhookCreateSchema.partial().extend({
  isActive: z.boolean().optional(),
})

export const bulkOperationSchema = z.object({
  type: z.enum([
    'assign_role',
    'remove_role',
    'grant_temporal',
    'grant_override',
    'archive_roles',
    'restore_roles',
    'apply_template',
    'revoke_temporals',
    'revoke_overrides',
  ]),
  items: z.array(z.record(z.unknown())).min(1),
})

export const transferImportSchema = z.object({
  roles: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      permissionKeys: z.array(z.string()).optional(),
    }),
  ).optional(),
  permissions: z.array(z.record(z.unknown())).optional(),
})

export const cacheInvalidateSchema = z.object({
  userId: z.string().optional(),
})

export const idParamSchema = z.object({
  id: z.string().min(1),
})

export const userIdParamSchema = z.object({
  userId: z.string().min(1),
})

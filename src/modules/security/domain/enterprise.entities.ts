import type { PermissionId } from '../../../common/permissions/registry.js'
import type {
  ConditionClause,
  ConditionLogic,
} from '../services/conditional-evaluation.js'

export type TemporalPermissionStatus = 'active' | 'revoked' | 'expired'
export type OverrideStatus = 'active' | 'revoked'
export type DelegationStatus = 'active' | 'revoked' | 'expired'
export type ApprovalStatus = 'pending' | 'approved' | 'rejected'
export type ScheduledChangeStatus = 'scheduled' | 'executed' | 'cancelled' | 'failed'
export type TemplateStatus = 'active' | 'archived'
export type ConditionalStatus = 'active' | 'inactive'

export interface TemporalPermissionEntity {
  _id?: string
  userId: string
  grantedBy: string
  permissionKeys: PermissionId[]
  reason: string
  startsAt: Date
  expiresAt: Date
  status: TemporalPermissionStatus
  revokedAt?: Date | null
  revokedBy?: string | null
  metadata?: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}

export interface UserPermissionOverrideEntity {
  _id?: string
  userId: string
  permissionKeys: PermissionId[]
  grantedBy: string
  reason: string
  status: OverrideStatus
  revokedAt?: Date | null
  revokedBy?: string | null
  createdAt: Date
  updatedAt: Date
}

export interface RoleDelegationEntity {
  _id?: string
  userId: string
  roleId: string
  roleName?: string | null
  roleKey?: string | null
  delegatedBy: string
  reason: string
  startsAt: Date
  expiresAt: Date
  status: DelegationStatus
  revokedAt?: Date | null
  revokedBy?: string | null
  createdAt: Date
  updatedAt: Date
}

export interface PermissionTemplateEntity {
  _id?: string
  name: string
  description: string
  permissionKeys: PermissionId[]
  category?: string | null
  color?: string | null
  icon?: string | null
  metadata?: Record<string, unknown>
  version: number
  status: TemplateStatus
  createdBy: string
  updatedBy: string
  createdAt: Date
  updatedAt: Date
  archivedAt?: Date | null
}

export interface ConditionalPermissionEntity {
  _id?: string
  name: string
  description: string
  permissionKeys: PermissionId[]
  conditions: ConditionClause[]
  logic: ConditionLogic
  priority: number
  status: ConditionalStatus
  appliesToUserId?: string | null
  createdBy: string
  updatedBy: string
  createdAt: Date
  updatedAt: Date
}

export type SensitiveAction =
  | 'grant_temporal'
  | 'grant_override'
  | 'delegate_role'
  | 'bulk_assign_roles'
  | 'import_permissions'
  | 'delete_role'

export interface ApprovalRequestEntity {
  _id?: string
  action: SensitiveAction
  payload: Record<string, unknown>
  summary: string
  risk: 'low' | 'medium' | 'high'
  requestedBy: string
  reviewedBy?: string | null
  status: ApprovalStatus
  reviewedAt?: Date | null
  rejectionReason?: string | null
  context?: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}

export type ScheduledActionType =
  | 'assign_role'
  | 'remove_role'
  | 'grant_temporal'
  | 'revoke_temporal'
  | 'archive_role'

export interface ScheduledChangeEntity {
  _id?: string
  action: ScheduledActionType
  payload: Record<string, unknown>
  summary: string
  executeAt: Date
  expiresAt?: Date | null
  status: ScheduledChangeStatus
  createdBy: string
  executedAt?: Date | null
  executionResult?: string | null
  createdAt: Date
  updatedAt: Date
}

export type AuditEntityType =
  | 'role'
  | 'permission'
  | 'user'
  | 'temporal'
  | 'override'
  | 'delegation'
  | 'template'
  | 'conditional'
  | 'approval'
  | 'webhook'

export type AuditAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'archive'
  | 'restore'
  | 'grant'
  | 'revoke'
  | 'approve'
  | 'reject'

export interface PermissionAuditEntry {
  _id?: string
  entityType: AuditEntityType
  entityId: string
  entityLabel: string
  action: AuditAction
  changedBy: string
  changedByEmail?: string | null
  before?: Record<string, unknown> | null
  after?: Record<string, unknown> | null
  summary: string
  ip?: string | null
  metadata?: Record<string, unknown>
  timestamp: Date
}

export type WebhookEventType =
  | 'role.created'
  | 'role.updated'
  | 'role.deleted'
  | 'permission.changed'
  | 'user.roles_changed'
  | 'temporal.granted'
  | 'approval.pending'

export interface SecurityWebhookEntity {
  _id?: string
  name: string
  url: string
  secret?: string | null
  events: WebhookEventType[]
  isActive: boolean
  createdBy: string
  updatedBy: string
  createdAt: Date
  updatedAt: Date
  lastTriggeredAt?: Date | null
  failureCount?: number
}

export interface ListFilters {
  page?: number
  limit?: number
  search?: string
  userId?: string
  status?: string
  grantedBy?: string
  delegatedBy?: string
  roleId?: string
  includeExpired?: boolean
}

export function toDomainId(entity: { _id?: string }): string {
  return entity._id ?? ''
}

export function serializeDates<T extends Record<string, unknown>>(obj: T): T {
  const out = { ...obj } as Record<string, unknown>
  for (const [k, v] of Object.entries(out)) {
    if (v instanceof Date) out[k] = v.toISOString()
  }
  if (out._id) {
    out.id = out._id
    delete out._id
  }
  return out as T
}

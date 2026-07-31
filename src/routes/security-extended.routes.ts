import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../app.context.js'
import { AppError } from '../common/errors/app.error.js'
import { PERMISSION_REGISTRY } from '../common/permissions/registry.js'
import { adminGuard } from '../modules/admin/middleware/admin-guard.js'
import type { AuthenticatedRequest } from '../modules/identity/middleware/auth.middleware.js'
import {
  approvalActionSchema,
  approvalCreateSchema,
  bulkOperationSchema,
  bulkRolesSchema,
  cacheInvalidateSchema,
  conditionalCreateSchema,
  delegationSchema,
  overrideGrantSchema,
  permissionCreateSchema,
  permissionPatchSchema,
  roleDuplicateSchema,
  roleImportSchema,
  scheduledChangeSchema,
  templateApplySchema,
  templateCreateSchema,
  temporalGrantSchema,
  temporalRevokeSchema,
  transferImportSchema,
  validateInheritanceSchema,
  webhookCreateSchema,
} from '../modules/security/schemas/security.schema.js'
import type { ScheduledActionType } from '../modules/security/domain/enterprise.entities.js'
import type { ConditionClause } from '../modules/security/services/conditional-evaluation.js'

type Guard = ReturnType<typeof adminGuard>

function parseBody<T>(schema: { safeParse: (v: unknown) => { success: boolean; data?: T; error?: unknown } }, body: unknown): T {
  const parsed = schema.safeParse(body)
  if (!parsed.success) throw AppError.badRequest('Invalid input', (parsed.error as { flatten?: () => unknown }).flatten?.())
  return parsed.data as T
}

export async function registerSecurityExtendedRoutes(api: FastifyInstance, ctx: AppContext) {
  const { services, repos } = ctx
  const admin = services.securityAdmin
  const enterprise = services.securityEnterprise

  const g = (permission: (typeof PERMISSION_REGISTRY)[keyof typeof PERMISSION_REGISTRY]): Guard =>
    adminGuard(repos.sessions, permission, services.authorization)

  const read = g(PERMISSION_REGISTRY.ADMIN_SECURITY_VIEW)
  const manage = g(PERMISSION_REGISTRY.ADMIN_SECURITY_MANAGE)
  const rolesRead = g(PERMISSION_REGISTRY.ADMIN_ROLES_READ)
  const rolesManage = g(PERMISSION_REGISTRY.ADMIN_ROLES_MANAGE)
  const permRead = g(PERMISSION_REGISTRY.ADMIN_PERMISSIONS_READ)
  const permManage = g(PERMISSION_REGISTRY.ADMIN_PERMISSIONS_MANAGE)
  const usersManage = g(PERMISSION_REGISTRY.ADMIN_USERS_MANAGE)
  const auditRead = g(PERMISSION_REGISTRY.ADMIN_AUDIT_READ)
  const sessionsRead = g(PERMISSION_REGISTRY.ADMIN_SESSIONS_READ)

  const authUser = (request: AuthenticatedRequest) => {
    const q = request.query as { userId?: string }
    return typeof q.userId === 'string' ? q.userId : request.auth.userId
  }

  // ─── 2FA admin ───
  api.get('/admin/auth/2fa/status', { preHandler: read }, async (request) => {
    const userId = authUser(request as AuthenticatedRequest)
    const status = await services.twoFactor.getStatus(userId)
    return { data: status ?? { enabled: false, confirmedAt: null, remainingBackupCodes: 0 } }
  })

  api.get('/admin/auth/2fa/enabled-users', { preHandler: read }, async (request) => {
    const limit = Number((request.query as { limit?: string }).limit) || 100
    const userIds = await services.twoFactor.listEnabledUserIds(limit)
    return { userIds }
  })

  api.post('/admin/auth/2fa/setup', { preHandler: manage }, async (request) => {
    const userId = authUser(request as AuthenticatedRequest)
    return services.twoFactor.setupForLumiaAdmin(userId)
  })

  api.post('/admin/auth/2fa/verify-setup', { preHandler: manage }, async (request) => {
    const userId = authUser(request as AuthenticatedRequest)
    const body = request.body as { code?: string; secret?: string; backupCodes?: string[] }
    if (!body.code || !body.secret || !Array.isArray(body.backupCodes)) {
      throw AppError.badRequest('code, secret y backupCodes son requeridos')
    }
    return services.twoFactor.verifySetupForLumiaAdmin(userId, {
      code: body.code,
      secretEncrypted: body.secret,
      backupCodes: body.backupCodes,
    })
  })

  api.post('/admin/auth/2fa/disable', { preHandler: manage }, async (request) => {
    const body = (request.body ?? {}) as { userId?: string }
    const req = request as AuthenticatedRequest
    const userId = typeof body.userId === 'string' ? body.userId : req.auth.userId
    return services.twoFactor.disableForLumiaAdmin(userId)
  })

  api.post('/admin/auth/2fa/regenerate-backup-codes', { preHandler: manage }, async (request) => {
    const userId = authUser(request as AuthenticatedRequest)
    return services.twoFactor.regenerateBackupCodes(userId)
  })

  // ─── Roles advanced ───
  api.get('/admin/security/roles/export', { preHandler: rolesRead }, async () => admin.exportRoles())
  api.post('/admin/security/roles/import', { preHandler: rolesManage }, async (request) => {
    const data = parseBody(roleImportSchema, request.body)
    return admin.importRoles(data)
  })
  api.post('/admin/security/roles/validate-inheritance', { preHandler: rolesRead }, async (request) => {
    const data = parseBody(validateInheritanceSchema, request.body)
    return admin.validateInheritance(data)
  })
  api.post('/admin/security/roles/archive/:id', { preHandler: rolesManage }, async (request) => {
    const { id } = request.params as { id: string }
    return admin.archiveRole(id)
  })
  api.post('/admin/security/roles/restore/:id', { preHandler: rolesManage }, async (request) => {
    const { id } = request.params as { id: string }
    return admin.restoreRole(id)
  })
  api.post('/admin/security/roles/duplicate/:id', { preHandler: rolesManage }, async (request) => {
    const { id } = request.params as { id: string }
    const data = parseBody(roleDuplicateSchema, request.body)
    return admin.duplicateRole(id, data)
  })
  api.get('/admin/security/roles/effective/:id', { preHandler: rolesRead }, async (request) => {
    const { id } = request.params as { id: string }
    return admin.getEffectiveRole(id)
  })
  api.get('/admin/security/roles/inheritance-graph', { preHandler: rolesRead }, async () =>
    admin.getInheritanceGraph(),
  )
  api.get('/admin/security/role-suggestions', { preHandler: read }, async () => enterprise.roleSuggestions())

  // ─── Permissions extended (static paths before :id) ───
  api.post('/admin/security/permissions', { preHandler: permManage }, async (request) => {
    const body = parseBody(permissionCreateSchema, request.body)
    return admin.createPermission(body)
  })
  api.post('/admin/security/permissions/sync', { preHandler: permManage }, async () => admin.syncPermissions())
  api.get('/admin/security/permissions/health', { preHandler: permRead }, async () => admin.permissionsHealth())
  api.get('/admin/security/permissions/:id', { preHandler: permRead }, async (request) => {
    const { id } = request.params as { id: string }
    return admin.getPermission(id)
  })
  api.patch('/admin/security/permissions/:id', { preHandler: permManage }, async (request) => {
    const { id } = request.params as { id: string }
    const patch = parseBody(permissionPatchSchema, request.body)
    return admin.patchPermission(id, patch)
  })

  // ─── Users bulk ───
  api.post('/admin/security/users/bulk-roles', { preHandler: usersManage }, async (request) => {
    const body = parseBody(bulkRolesSchema, request.body)
    const auth = (request as AuthenticatedRequest).auth
    return admin.bulkAssignRoles({ ...body, assignedBy: auth.userId })
  })

  // ─── Dashboards ───
  api.get('/admin/security/rbac-dashboard', { preHandler: read }, async () => enterprise.rbacDashboard())
  api.get('/admin/security/dashboard', { preHandler: read }, async () => enterprise.securityDashboard())
  api.get('/admin/security/analytics', { preHandler: read }, async () => enterprise.analytics())
  api.get('/admin/security/reports', { preHandler: read }, async () => enterprise.complianceReport())

  // ─── Sessions ───
  api.get('/admin/security-sessions', { preHandler: sessionsRead }, async (request) =>
    enterprise.listSecuritySessionsDashboard(request.query as Record<string, unknown>),
  )
  api.get('/admin/security/sessions', { preHandler: sessionsRead }, async (request) =>
    enterprise.listSecuritySessions(request.query as Record<string, unknown>),
  )

  // ─── Audit (auth audit: ver GET /admin/audit-log en admin.routes.ts) ───
  api.get('/admin/security/permission-audit', { preHandler: auditRead }, async (request) =>
    enterprise.listPermissionAudit(request.query as Record<string, unknown>),
  )
  api.get('/admin/security/permission-audit/stats', { preHandler: auditRead }, async () =>
    enterprise.permissionAuditStats(),
  )
  api.get('/admin/security/permission-audit/:id', { preHandler: auditRead }, async (request) => {
    const { id } = request.params as { id: string }
    return enterprise.getPermissionAudit(id)
  })

  // ─── Debug ───
  api.get('/admin/debug/permissions/:userId', { preHandler: manage }, async (request) => {
    const { userId } = request.params as { userId: string }
    return enterprise.debugPermissions(userId)
  })
  api.get('/admin/debug/permission-explain/:userId', { preHandler: manage }, async (request) => {
    const { userId } = request.params as { userId: string }
    return enterprise.explainPermissions(userId)
  })

  // ─── Temporal permissions (7 routes) ───
  api.post('/admin/security/temporal-permissions/grant', { preHandler: manage }, async (request) => {
    const body = parseBody(temporalGrantSchema, request.body)
    const auth = (request as AuthenticatedRequest).auth
    return enterprise.grantTemporal({ ...body, grantedBy: auth.userId })
  })
  api.post('/admin/security/temporal-permissions/revoke', { preHandler: manage }, async (request) => {
    const body = parseBody(temporalRevokeSchema, request.body)
    const auth = (request as AuthenticatedRequest).auth
    return enterprise.revokeTemporal(body.id, auth.userId)
  })
  api.get('/admin/security/temporal-permissions', { preHandler: read }, async (request) =>
    enterprise.listTemporal(request.query as Record<string, unknown>),
  )
  api.get('/admin/security/temporal-permissions/user/:userId', { preHandler: read }, async (request) => {
    const { userId } = request.params as { userId: string }
    return enterprise.listTemporalByUser(userId)
  })
  api.post('/admin/security/temporal-permissions/expire-all', { preHandler: manage }, async () =>
    enterprise.expireAllTemporal(),
  )
  api.get('/admin/security/temporal-permissions/:id', { preHandler: read }, async (request) => {
    const { id } = request.params as { id: string }
    return enterprise.getTemporal(id)
  })

  // ─── User overrides (5 routes) ───
  api.post('/admin/security/user-overrides/grant', { preHandler: manage }, async (request) => {
    const body = parseBody(overrideGrantSchema, request.body)
    const auth = (request as AuthenticatedRequest).auth
    return enterprise.grantOverride({ ...body, grantedBy: auth.userId })
  })
  api.post('/admin/security/user-overrides/revoke', { preHandler: manage }, async (request) => {
    const { id } = parseBody(temporalRevokeSchema, request.body)
    const auth = (request as AuthenticatedRequest).auth
    return enterprise.revokeOverride(id, auth.userId)
  })
  api.get('/admin/security/user-overrides', { preHandler: read }, async (request) =>
    enterprise.listOverrides(request.query as Record<string, unknown>),
  )
  api.get('/admin/security/user-overrides/user/:userId', { preHandler: read }, async (request) => {
    const { userId } = request.params as { userId: string }
    return enterprise.listOverridesByUser(userId)
  })
  api.get('/admin/security/user-overrides/:id', { preHandler: read }, async (request) => {
    const { id } = request.params as { id: string }
    return enterprise.getOverride(id)
  })

  // ─── Role delegations (6 routes) ───
  api.post('/admin/security/role-delegations/delegate', { preHandler: manage }, async (request) => {
    const body = parseBody(delegationSchema, request.body)
    const auth = (request as AuthenticatedRequest).auth
    return enterprise.delegateRole({ ...body, delegatedBy: auth.userId })
  })
  api.post('/admin/security/role-delegations/revoke', { preHandler: manage }, async (request) => {
    const { id } = parseBody(temporalRevokeSchema, request.body)
    const auth = (request as AuthenticatedRequest).auth
    return enterprise.revokeDelegation(id, auth.userId)
  })
  api.get('/admin/security/role-delegations', { preHandler: read }, async (request) =>
    enterprise.listDelegations(request.query as Record<string, unknown>),
  )
  api.get('/admin/security/role-delegations/available-roles', { preHandler: read }, async () =>
    enterprise.listAvailableDelegationRoles(),
  )
  api.post('/admin/security/role-delegations/expire-all', { preHandler: manage }, async () =>
    enterprise.expireAllDelegations(),
  )
  api.get('/admin/security/role-delegations/:id', { preHandler: read }, async (request) => {
    const { id } = request.params as { id: string }
    return enterprise.getDelegation(id)
  })

  // ─── Permission templates (9 routes) ───
  api.post('/admin/security/permission-templates/create', { preHandler: manage }, async (request) => {
    const body = parseBody(templateCreateSchema, request.body)
    const auth = (request as AuthenticatedRequest).auth
    return enterprise.createTemplate({ ...body, createdBy: auth.userId })
  })
  api.post('/admin/security/permission-templates/update', { preHandler: manage }, async (request) => {
    const { id, ...patch } = request.body as { id: string } & Record<string, unknown>
    if (!id) throw AppError.badRequest('id es requerido')
    const auth = (request as AuthenticatedRequest).auth
    return enterprise.updateTemplate(id, patch, auth.userId)
  })
  api.post('/admin/security/permission-templates/archive', { preHandler: manage }, async (request) => {
    const { id } = request.body as { id?: string }
    if (!id) throw AppError.badRequest('id es requerido')
    return enterprise.archiveTemplate(id)
  })
  api.post('/admin/security/permission-templates/restore', { preHandler: manage }, async (request) => {
    const { id } = request.body as { id?: string }
    if (!id) throw AppError.badRequest('id es requerido')
    return enterprise.restoreTemplate(id)
  })
  api.post('/admin/security/permission-templates/apply', { preHandler: manage }, async (request) => {
    const body = parseBody(templateApplySchema, request.body)
    return enterprise.applyTemplate(body.templateId, body.roleId)
  })
  api.get('/admin/security/permission-templates', { preHandler: read }, async (request) =>
    enterprise.listTemplates(request.query as Record<string, unknown>),
  )
  api.get('/admin/security/permission-templates/active', { preHandler: read }, async () =>
    enterprise.listActiveTemplates(),
  )
  api.get('/admin/security/permission-templates/drift', { preHandler: read }, async () =>
    enterprise.getTemplateDrift(),
  )
  api.get('/admin/security/permission-templates/:id', { preHandler: read }, async (request) => {
    const { id } = request.params as { id: string }
    return enterprise.getTemplate(id)
  })

  // ─── Conditional permissions (8 routes) ───
  api.post('/admin/security/conditional-permissions/create', { preHandler: manage }, async (request) => {
    const body = parseBody(conditionalCreateSchema, request.body)
    const auth = (request as AuthenticatedRequest).auth
    return enterprise.createConditional({
      ...body,
      conditions: body.conditions as unknown as ConditionClause[],
      createdBy: auth.userId,
    })
  })
  api.post('/admin/security/conditional-permissions/update', { preHandler: manage }, async (request) => {
    const { id, ...patch } = request.body as { id: string } & Record<string, unknown>
    if (!id) throw AppError.badRequest('id es requerido')
    const auth = (request as AuthenticatedRequest).auth
    return enterprise.updateConditional(id, patch, auth.userId)
  })
  api.post('/admin/security/conditional-permissions/toggle-status', { preHandler: manage }, async (request) => {
    const { id, status } = request.body as { id?: string; status?: 'active' | 'inactive' }
    if (!id || !status) throw AppError.badRequest('id y status son requeridos')
    return enterprise.toggleConditional(id, status)
  })
  api.post('/admin/security/conditional-permissions/delete', { preHandler: manage }, async (request) => {
    const { id } = request.body as { id?: string }
    if (!id) throw AppError.badRequest('id es requerido')
    return enterprise.deleteConditional(id)
  })
  api.get('/admin/security/conditional-permissions', { preHandler: read }, async (request) =>
    enterprise.listConditional(request.query as Record<string, unknown>),
  )
  api.get('/admin/security/conditional-permissions/evaluate', { preHandler: read }, async (request) =>
    enterprise.evaluateConditional(request.query as never),
  )
  api.get('/admin/security/conditional-permissions/:id', { preHandler: read }, async (request) => {
    const { id } = request.params as { id: string }
    return enterprise.getConditional(id)
  })

  // ─── Approvals (5 routes) ───
  api.get('/admin/security/approvals', { preHandler: read }, async (request) =>
    enterprise.listApprovals(request.query as Record<string, unknown>),
  )
  api.get('/admin/security/approvals/pending-count', { preHandler: read }, async () =>
    enterprise.pendingApprovalCount(),
  )
  api.get('/admin/security/approvals/:id', { preHandler: read }, async (request) => {
    const { id } = request.params as { id: string }
    return enterprise.getApproval(id)
  })
  api.post('/admin/security/approvals/approve', { preHandler: manage }, async (request) => {
    const body = parseBody(approvalActionSchema, request.body)
    const auth = (request as AuthenticatedRequest).auth
    return enterprise.approveRequest(body.id, auth.userId)
  })
  api.post('/admin/security/approvals/reject', { preHandler: manage }, async (request) => {
    const body = parseBody(approvalActionSchema, request.body)
    const auth = (request as AuthenticatedRequest).auth
    return enterprise.rejectRequest(body.id, auth.userId, body.reason)
  })
  api.post('/admin/security/approvals/request', { preHandler: manage }, async (request) => {
    const body = parseBody(approvalCreateSchema, request.body)
    const auth = (request as AuthenticatedRequest).auth
    return enterprise.createApproval({
      action: body.action as never,
      payload: body.payload,
      summary: body.summary,
      risk: body.risk,
      requestedBy: auth.userId,
    })
  })

  // ─── Scheduled changes (4 routes) ───
  api.post('/admin/security/scheduled-changes/schedule', { preHandler: manage }, async (request) => {
    const body = parseBody(scheduledChangeSchema, request.body)
    const auth = (request as AuthenticatedRequest).auth
    return enterprise.scheduleChange({
      ...body,
      action: body.action as ScheduledActionType,
      createdBy: auth.userId,
    })
  })
  api.post('/admin/security/scheduled-changes/cancel', { preHandler: manage }, async (request) => {
    const { id } = request.body as { id?: string }
    if (!id) throw AppError.badRequest('id es requerido')
    return enterprise.cancelScheduled(id)
  })
  api.get('/admin/security/scheduled-changes', { preHandler: read }, async (request) =>
    enterprise.listScheduled(request.query as Record<string, unknown>),
  )
  api.get('/admin/security/scheduled-changes/:id', { preHandler: read }, async (request) => {
    const { id } = request.params as { id: string }
    return enterprise.getScheduled(id)
  })

  // ─── Transfer ───
  api.get('/admin/security/transfer/export', { preHandler: permRead }, async () => enterprise.exportTransfer())
  api.post('/admin/security/transfer/preview', { preHandler: permManage }, async (request) => {
    const data = parseBody(transferImportSchema, request.body)
    return enterprise.previewTransfer(data)
  })
  api.post('/admin/security/transfer/import', { preHandler: permManage }, async (request) => {
    const data = parseBody(transferImportSchema, request.body)
    const auth = (request as AuthenticatedRequest).auth
    return enterprise.importTransfer(data, auth.userId)
  })

  // ─── Cache ───
  api.get('/admin/security/cache', { preHandler: read }, async () => enterprise.cacheStats())
  api.post('/admin/security/cache/invalidate', { preHandler: manage }, async (request) => {
    const body = parseBody(cacheInvalidateSchema, request.body ?? {})
    return enterprise.invalidateCache(body.userId)
  })
  api.post('/admin/security/cache/prune', { preHandler: manage }, async () => enterprise.pruneCache())
  api.post('/admin/security/cache/reset-stats', { preHandler: manage }, async () => enterprise.resetCacheStats())

  // ─── Webhooks ───
  api.get('/admin/security/webhooks', { preHandler: read }, async () => enterprise.listWebhooks())
  api.post('/admin/security/webhooks/create', { preHandler: manage }, async (request) => {
    const body = parseBody(webhookCreateSchema, request.body)
    const auth = (request as AuthenticatedRequest).auth
    return enterprise.createWebhook({ ...body, events: body.events as never, createdBy: auth.userId })
  })
  api.post('/admin/security/webhooks/update', { preHandler: manage }, async (request) => {
    const { id, ...patch } = request.body as { id: string } & Record<string, unknown>
    if (!id) throw AppError.badRequest('id es requerido')
    const auth = (request as AuthenticatedRequest).auth
    return enterprise.updateWebhook(id, patch, auth.userId)
  })
  api.post('/admin/security/webhooks/delete', { preHandler: manage }, async (request) => {
    const { id } = request.body as { id?: string }
    if (!id) throw AppError.badRequest('id es requerido')
    return enterprise.deleteWebhook(id)
  })
  api.post('/admin/security/webhooks/test', { preHandler: manage }, async (request) => {
    const { id } = request.body as { id?: string }
    if (!id) throw AppError.badRequest('id es requerido')
    return enterprise.testWebhook(id)
  })

  // ─── Bulk ───
  api.post('/admin/security/bulk', { preHandler: manage }, async (request) => {
    const body = parseBody(bulkOperationSchema, request.body)
    const auth = (request as AuthenticatedRequest).auth
    return enterprise.executeBulk({ ...body, performedBy: auth.userId })
  })
}

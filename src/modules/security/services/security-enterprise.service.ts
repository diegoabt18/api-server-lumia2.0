import { AppError } from '../../../common/errors/app.error.js'
import {
  expandPermissions,
  type UserRole,
} from '../../../common/permissions/registry.js'
import { buildPaginationMeta, resolvePagingQuery } from '../../../common/utils/pagination.js'
import type { RegistryRepository } from '../../admin/infrastructure/registry.repository.js'
import type { AuthAuditRepository } from '../../identity/infrastructure/auth-audit.repository.js'
import type { SessionRepository } from '../../identity/infrastructure/session.repository.js'
import type { UserRepository } from '../../identity/infrastructure/user.repository.js'
import { serializeDates } from '../domain/enterprise.entities.js'
import type { ApprovalRequestRepository } from '../infrastructure/approval-request.repository.js'
import type { ConditionalPermissionRepository } from '../infrastructure/conditional-permission.repository.js'
import type { PermissionAuditRepository } from '../infrastructure/permission-audit.repository.js'
import type { PermissionTemplateRepository } from '../infrastructure/permission-template.repository.js'
import type { RoleDelegationRepository } from '../infrastructure/role-delegation.repository.js'
import type { RoleRepository } from '../infrastructure/role.repository.js'
import type { ScheduledChangeRepository } from '../infrastructure/scheduled-change.repository.js'
import type { SecurityWebhookRepository } from '../infrastructure/security-webhook.repository.js'
import type { TemporalPermissionRepository } from '../infrastructure/temporal-permission.repository.js'
import type { UserPermissionOverrideRepository } from '../infrastructure/user-permission-override.repository.js'
import type { UserRoleRepository } from '../infrastructure/user-role.repository.js'
import type { AuthorizationService } from './authorization.service.js'
import type { PermissionCacheService } from './permission-cache.service.js'
import { ConditionEvaluationEngine, type ConditionClause, type ConditionContext } from './conditional-evaluation.js'

function mapEntity<T extends { _id?: string }>(item: T) {
  const { _id, ...rest } = item
  return serializeDates({ id: _id, ...rest } as Record<string, unknown>)
}

export class SecurityEnterpriseService {
  constructor(
    private readonly roles: RoleRepository,
    private readonly userRoles: UserRoleRepository,
    private readonly users: UserRepository,
    private readonly registry: RegistryRepository,
    private readonly authorization: AuthorizationService,
    private readonly temporal: TemporalPermissionRepository,
    private readonly overrides: UserPermissionOverrideRepository,
    private readonly delegations: RoleDelegationRepository,
    private readonly templates: PermissionTemplateRepository,
    private readonly conditional: ConditionalPermissionRepository,
    private readonly approvals: ApprovalRequestRepository,
    private readonly scheduled: ScheduledChangeRepository,
    private readonly permAudit: PermissionAuditRepository,
    private readonly webhooks: SecurityWebhookRepository,
    private readonly authAudit: AuthAuditRepository,
    private readonly sessions: SessionRepository,
    private readonly permCache: PermissionCacheService,
  ) {}

  // ─── Temporal permissions ───
  async grantTemporal(body: {
    userId: string
    permissionKeys: string[]
    reason: string
    startsAt: string
    expiresAt: string
    grantedBy: string
  }) {
    const item = await this.temporal.create({
      userId: body.userId,
      grantedBy: body.grantedBy,
      permissionKeys: body.permissionKeys,
      reason: body.reason,
      startsAt: new Date(body.startsAt),
      expiresAt: new Date(body.expiresAt),
    })
    await this.authorization.invalidateUserCache(body.userId)
    await this.permAudit.append({
      entityType: 'temporal',
      entityId: item._id!,
      entityLabel: body.userId,
      action: 'grant',
      changedBy: body.grantedBy,
      summary: `Temporal grant: ${body.reason}`,
      timestamp: new Date(),
    })
    return { item: mapEntity(item) }
  }

  async revokeTemporal(id: string, revokedBy: string) {
    const existing = await this.temporal.findByIdSafe(id)
    if (!existing) throw AppError.notFound('Permiso temporal no encontrado')
    const ok = await this.temporal.revoke(id, revokedBy)
    if (!ok) throw AppError.badRequest('No se pudo revocar')
    await this.authorization.invalidateUserCache(existing.userId)
    return { ok: true }
  }

  async listTemporal(query: Record<string, unknown>) {
    const { page, limit } = resolvePagingQuery(query)
    const { items, total } = await this.temporal.list({
      page,
      limit,
      userId: typeof query.userId === 'string' ? query.userId : undefined,
      status: typeof query.status === 'string' ? query.status : undefined,
      search: typeof query.search === 'string' ? query.search : undefined,
    })
    return { items: items.map(mapEntity), total, pagination: buildPaginationMeta(total, page, limit) }
  }

  async getTemporal(id: string) {
    const item = await this.temporal.findByIdSafe(id)
    if (!item) throw AppError.notFound('No encontrado')
    return { item: mapEntity(item) }
  }

  async listTemporalByUser(userId: string) {
    const items = await this.temporal.findActiveByUserId(userId)
    return { items: items.map(mapEntity) }
  }

  async expireAllTemporal() {
    const count = await this.temporal.expireAllOverdue()
    return { expired: count }
  }

  // ─── User overrides ───
  async grantOverride(body: { userId: string; permissionKeys: string[]; reason: string; grantedBy: string }) {
    const item = await this.overrides.create(body)
    await this.authorization.invalidateUserCache(body.userId)
    return { item: mapEntity(item) }
  }

  async revokeOverride(id: string, revokedBy: string) {
    const existing = await this.overrides.findByIdSafe(id)
    if (!existing) throw AppError.notFound('Override no encontrado')
    await this.overrides.revoke(id, revokedBy)
    await this.authorization.invalidateUserCache(existing.userId)
    return { ok: true }
  }

  async listOverrides(query: Record<string, unknown>) {
    const { page, limit } = resolvePagingQuery(query)
    const { items, total } = await this.overrides.list({
      page,
      limit,
      userId: typeof query.userId === 'string' ? query.userId : undefined,
      status: typeof query.status === 'string' ? query.status : undefined,
      search: typeof query.search === 'string' ? query.search : undefined,
    })
    return { items: items.map(mapEntity), total, pagination: buildPaginationMeta(total, page, limit) }
  }

  async getOverride(id: string) {
    const item = await this.overrides.findByIdSafe(id)
    if (!item) throw AppError.notFound('No encontrado')
    return { item: mapEntity(item) }
  }

  async listOverridesByUser(userId: string) {
    const items = await this.overrides.findActiveByUserId(userId)
    return { items: items.map(mapEntity) }
  }

  // ─── Role delegations ───
  async delegateRole(body: {
    userId: string
    roleId: string
    reason: string
    startsAt: string
    expiresAt: string
    delegatedBy: string
  }) {
    const role = await this.roles.findByIdSafe(body.roleId)
    if (!role) throw AppError.notFound('Rol no encontrado')
    const item = await this.delegations.create({
      ...body,
      roleName: role.name,
      roleKey: role.key,
      startsAt: new Date(body.startsAt),
      expiresAt: new Date(body.expiresAt),
    })
    await this.authorization.invalidateUserCache(body.userId)
    return { item: mapEntity(item) }
  }

  async revokeDelegation(id: string, revokedBy: string) {
    const existing = await this.delegations.findByIdSafe(id)
    if (!existing) throw AppError.notFound('Delegación no encontrada')
    await this.delegations.revoke(id, revokedBy)
    await this.authorization.invalidateUserCache(existing.userId)
    return { ok: true }
  }

  async listDelegations(query: Record<string, unknown>) {
    const { page, limit } = resolvePagingQuery(query)
    const { items, total } = await this.delegations.list({
      page,
      limit,
      userId: typeof query.userId === 'string' ? query.userId : undefined,
      roleId: typeof query.roleId === 'string' ? query.roleId : undefined,
      search: typeof query.search === 'string' ? query.search : undefined,
    })
    return { items: items.map(mapEntity), total, pagination: buildPaginationMeta(total, page, limit) }
  }

  async getDelegation(id: string) {
    const item = await this.delegations.findByIdSafe(id)
    if (!item) throw AppError.notFound('No encontrado')
    return { item: mapEntity(item) }
  }

  async listAvailableDelegationRoles() {
    const items = await this.roles.list()
    return { items: items.filter((r) => !r.isArchived).map((r) => this.roles.toDomain(r)) }
  }

  async expireAllDelegations() {
    return { expired: await this.delegations.expireAllOverdue() }
  }

  // ─── Permission templates ───
  async createTemplate(body: {
    name: string
    description?: string
    permissionKeys: string[]
    category?: string
    createdBy: string
  }) {
    if (await this.templates.existsByName(body.name)) {
      throw AppError.conflict('Ya existe una plantilla con ese nombre')
    }
    const item = await this.templates.create(body)
    return { item: mapEntity(item) }
  }

  async updateTemplate(id: string, patch: Record<string, unknown>, updatedBy: string) {
    const item = await this.templates.update(id, { ...patch, updatedBy } as never)
    if (!item) throw AppError.notFound('Plantilla no encontrada')
    return { item: mapEntity(item) }
  }

  async listTemplates(query: Record<string, unknown>) {
    const { page, limit } = resolvePagingQuery(query)
    const { items, total } = await this.templates.list({
      page,
      limit,
      status: query.status as 'active' | 'archived' | undefined,
      category: typeof query.category === 'string' ? query.category : undefined,
      search: typeof query.search === 'string' ? query.search : undefined,
    })
    return { items: items.map(mapEntity), total, pagination: buildPaginationMeta(total, page, limit) }
  }

  async listActiveTemplates() {
    return { items: (await this.templates.listActive()).map(mapEntity) }
  }

  async getTemplate(id: string) {
    const item = await this.templates.findByIdSafe(id)
    if (!item) throw AppError.notFound('Plantilla no encontrada')
    return { item: mapEntity(item) }
  }

  async archiveTemplate(id: string) {
    if (!(await this.templates.archive(id))) throw AppError.notFound('Plantilla no encontrada')
    return { ok: true }
  }

  async restoreTemplate(id: string) {
    if (!(await this.templates.restore(id))) throw AppError.notFound('Plantilla no encontrada')
    return { ok: true }
  }

  async applyTemplate(templateId: string, roleId: string) {
    const template = await this.templates.findByIdSafe(templateId)
    if (!template) throw AppError.notFound('Plantilla no encontrada')
    const role = await this.roles.update(roleId, { permissionKeys: template.permissionKeys })
    if (!role) throw AppError.notFound('Rol no encontrado')
    return { role: this.roles.toDomain(role) }
  }

  async getTemplateDrift() {
    const templates = await this.templates.listActive()
    const roles = await this.roles.list()
    const drift = templates.map((t) => {
      const matching = roles.filter((r) => {
        const a = new Set(r.permissionKeys)
        return t.permissionKeys.every((k) => a.has(k))
      })
      return { templateId: t._id, templateName: t.name, matchingRoles: matching.length }
    })
    return { items: drift }
  }

  // ─── Conditional permissions ───
  async createConditional(body: {
    name: string
    description?: string
    permissionKeys: string[]
    conditions: ConditionClause[]
    logic?: 'AND' | 'OR'
    priority?: number
    appliesToUserId?: string | null
    createdBy: string
  }) {
    const item = await this.conditional.create(body)
    return { item: mapEntity(item) }
  }

  async updateConditional(id: string, patch: Record<string, unknown>, updatedBy: string) {
    const item = await this.conditional.update(id, { ...patch, updatedBy } as never)
    if (!item) throw AppError.notFound('Regla no encontrada')
    return { item: mapEntity(item) }
  }

  async listConditional(query: Record<string, unknown>) {
    const { page, limit } = resolvePagingQuery(query)
    const { items, total } = await this.conditional.list({
      page,
      limit,
      status: query.status as 'active' | 'inactive' | undefined,
      search: typeof query.search === 'string' ? query.search : undefined,
    })
    return { items: items.map(mapEntity), total, pagination: buildPaginationMeta(total, page, limit) }
  }

  async getConditional(id: string) {
    const item = await this.conditional.findByIdSafe(id)
    if (!item) throw AppError.notFound('Regla no encontrada')
    return { item: mapEntity(item) }
  }

  async toggleConditional(id: string, status: 'active' | 'inactive') {
    if (!(await this.conditional.setStatus(id, status))) throw AppError.notFound('Regla no encontrada')
    return { ok: true, status }
  }

  async deleteConditional(id: string) {
    if (!(await this.conditional.deleteSafe(id))) throw AppError.notFound('Regla no encontrada')
    return { ok: true }
  }

  async evaluateConditional(ctx: Partial<ConditionContext>) {
    const active = await this.conditional.listActive()
    const context: ConditionContext = {
      currentTime: ctx.currentTime ?? new Date(),
      userId: ctx.userId ?? '',
      userAttributes: ctx.userAttributes ?? {},
      ip: ctx.ip ?? null,
    }
    const keys = ConditionEvaluationEngine.evaluate(active, context)
    return { matchedKeys: keys, rulesEvaluated: active.length }
  }

  // ─── Approvals ───
  async listApprovals(query: Record<string, unknown>) {
    const { page, limit } = resolvePagingQuery(query)
    const { items, total } = await this.approvals.list({
      page,
      limit,
      status: query.status as never,
      action: query.action as never,
      search: typeof query.search === 'string' ? query.search : undefined,
    })
    return { items: items.map(mapEntity), total, pagination: buildPaginationMeta(total, page, limit) }
  }

  async getApproval(id: string) {
    const item = await this.approvals.findByIdSafe(id)
    if (!item) throw AppError.notFound('Solicitud no encontrada')
    return { item: mapEntity(item) }
  }

  async pendingApprovalCount() {
    return { count: await this.approvals.countPending() }
  }

  async approveRequest(id: string, reviewedBy: string) {
    if (!(await this.approvals.approve(id, reviewedBy))) throw AppError.badRequest('No se pudo aprobar')
    return { ok: true }
  }

  async rejectRequest(id: string, reviewedBy: string, reason?: string) {
    if (!(await this.approvals.reject(id, reviewedBy, reason))) throw AppError.badRequest('No se pudo rechazar')
    return { ok: true }
  }

  async createApproval(body: {
    action: import('../domain/enterprise.entities.js').SensitiveAction
    payload: Record<string, unknown>
    summary: string
    requestedBy: string
    risk?: 'low' | 'medium' | 'high'
  }) {
    const item = await this.approvals.create(body)
    return { item: mapEntity(item) }
  }

  // ─── Scheduled changes ───
  async scheduleChange(body: {
    action: import('../domain/enterprise.entities.js').ScheduledActionType
    payload: Record<string, unknown>
    summary: string
    executeAt: string
    createdBy: string
  }) {
    const item = await this.scheduled.create({
      ...body,
      executeAt: new Date(body.executeAt),
    })
    return { item: mapEntity(item) }
  }

  async listScheduled(query: Record<string, unknown>) {
    const { page, limit } = resolvePagingQuery(query)
    const { items, total } = await this.scheduled.list({
      page,
      limit,
      status: query.status as never,
      search: typeof query.search === 'string' ? query.search : undefined,
    })
    return { items: items.map(mapEntity), total, pagination: buildPaginationMeta(total, page, limit) }
  }

  async getScheduled(id: string) {
    const item = await this.scheduled.findByIdSafe(id)
    if (!item) throw AppError.notFound('Cambio programado no encontrado')
    return { item: mapEntity(item) }
  }

  async cancelScheduled(id: string) {
    if (!(await this.scheduled.cancel(id))) throw AppError.notFound('Cambio no encontrado')
    return { ok: true }
  }

  // ─── Webhooks ───
  async listWebhooks() {
    return { items: (await this.webhooks.list()).map(mapEntity) }
  }

  async createWebhook(body: {
    name: string
    url: string
    secret?: string
    events: import('../domain/enterprise.entities.js').WebhookEventType[]
    createdBy: string
  }) {
    const item = await this.webhooks.create(body)
    return { item: mapEntity(item) }
  }

  async updateWebhook(id: string, patch: Record<string, unknown>, updatedBy: string) {
    const item = await this.webhooks.update(id, { ...patch, updatedBy } as never)
    if (!item) throw AppError.notFound('Webhook no encontrado')
    return { item: mapEntity(item) }
  }

  async deleteWebhook(id: string) {
    if (!(await this.webhooks.deleteSafe(id))) throw AppError.notFound('Webhook no encontrado')
    return { ok: true }
  }

  async testWebhook(id: string) {
    const hook = await this.webhooks.findByIdSafe(id)
    if (!hook) throw AppError.notFound('Webhook no encontrado')
    return { ok: true, tested: true, url: hook.url, message: 'Test dispatch simulated' }
  }

  // ─── Audit ───
  async listAuthAudit(query: Record<string, unknown>) {
    const { page, limit, skip } = resolvePagingQuery(query, { defaultLimit: 50, maxLimit: 200 })
    const from = typeof query.from === 'string' ? new Date(query.from) : undefined
    const to = typeof query.to === 'string' ? new Date(query.to) : undefined
    const { items, total } = await this.authAudit.query({
      userId: typeof query.userId === 'string' ? query.userId : undefined,
      event: query.event as never,
      from: from && !Number.isNaN(from.getTime()) ? from : undefined,
      to: to && !Number.isNaN(to.getTime()) ? to : undefined,
      limit,
      skip,
      search: typeof query.search === 'string' ? query.search : undefined,
    })
    return {
      items: items.map((e) => ({ ...e, id: e._id, createdAt: e.createdAt.toISOString() })),
      total,
      pagination: buildPaginationMeta(total, page, limit),
    }
  }

  async listPermissionAudit(query: Record<string, unknown>) {
    const { page, limit } = resolvePagingQuery(query, { defaultLimit: 50, maxLimit: 200 })
    const { items, total } = await this.permAudit.list({
      page,
      limit,
      entityType: query.entityType as never,
      entityId: typeof query.entityId === 'string' ? query.entityId : undefined,
      action: query.action as never,
      changedBy: typeof query.changedBy === 'string' ? query.changedBy : undefined,
      search: typeof query.search === 'string' ? query.search : undefined,
      dateFrom: typeof query.dateFrom === 'string' ? query.dateFrom : undefined,
      dateTo: typeof query.dateTo === 'string' ? query.dateTo : undefined,
    })
    return { items: items.map(mapEntity), total, pagination: buildPaginationMeta(total, page, limit) }
  }

  async getPermissionAudit(id: string) {
    const item = await this.permAudit.findByIdSafe(id)
    if (!item) throw AppError.notFound('Entrada no encontrada')
    return { item: mapEntity(item) }
  }

  async permissionAuditStats() {
    return this.permAudit.getStats()
  }

  // ─── Sessions ───
  async listSecuritySessions(query: Record<string, unknown>) {
    const { page, limit, skip } = resolvePagingQuery(query, { defaultLimit: 50, maxLimit: 200 })
    const { items, total } = await this.sessions.listForAdmin({
      userId: typeof query.userId === 'string' ? query.userId : undefined,
      limit,
      skip,
    })
    return {
      items: items.map((s) => ({
        id: s._id,
        userId: s.userId,
        deviceName: s.deviceName ?? null,
        browser: s.browser ?? null,
        os: s.os ?? null,
        ipAddress: s.ipAddress ?? null,
        lastUsedAt: s.lastUsedAt?.toISOString?.() ?? null,
        suspicious: !!s.suspicious,
        riskScore: s.riskScore ?? 0,
      })),
      total,
      pagination: buildPaginationMeta(total, page, limit),
    }
  }

  // ─── Dashboards ───
  async rbacDashboard() {
    const [roles, templates, temporal, overrides, delegations, pendingApprovals] = await Promise.all([
      this.roles.list(),
      this.templates.listActive(),
      this.temporal.list({ limit: 5, page: 1 }),
      this.overrides.list({ limit: 5, page: 1 }),
      this.delegations.list({ limit: 5, page: 1 }),
      this.approvals.countPending(),
    ])
    return {
      counts: {
        roles: roles.length,
        templates: templates.length,
        activeTemporal: temporal.total,
        activeOverrides: overrides.total,
        activeDelegations: delegations.total,
        pendingApprovals,
      },
      recentTemporal: temporal.items.map(mapEntity),
      recentOverrides: overrides.items.map(mapEntity),
    }
  }

  async securityDashboard() {
    const [activeSessions, recentAuth] = await Promise.all([
      this.sessions.countActive(),
      this.authAudit.listRecent(20),
    ])
    return {
      activeSessions,
      recentAuthEvents: recentAuth.map((e) => ({
        id: e._id,
        event: e.event,
        email: e.email,
        createdAt: e.createdAt.toISOString(),
      })),
    }
  }

  async analytics() {
    const roles = await this.roles.list()
    const roleAssignments = await this.userRoles.count({} as never)
    return {
      totalRoles: roles.length,
      systemRoles: roles.filter((r) => r.isSystem).length,
      archivedRoles: roles.filter((r) => r.isArchived).length,
      avgPermissionsPerRole:
        roles.length > 0
          ? roles.reduce((acc, r) => acc + r.permissionKeys.length, 0) / roles.length
          : 0,
      roleAssignments,
    }
  }

  async roleSuggestions() {
    const templates = await this.templates.listActive()
    const roles = await this.roles.list()
    const suggestions = templates.map((t) => ({
      type: 'apply_template' as const,
      templateId: t._id,
      templateName: t.name,
      suggestedForRoles: roles
        .filter((r) => !r.isSystem && r.permissionKeys.length < t.permissionKeys.length)
        .slice(0, 3)
        .map((r) => ({ id: r._id, key: r.key, name: r.name })),
    }))
    return { items: suggestions }
  }

  async complianceReport() {
    const roles = await this.roles.list()
    const users = await this.users.listForSecurity(0, 500, { staffOnly: true })
    const staffWithoutRoles = []
    for (const u of users.items) {
      const assignments = await this.userRoles.findByUserId(u._id!)
      if (!assignments.length && u.role !== 'admin') {
        staffWithoutRoles.push({ userId: u._id, email: u.email })
      }
    }
    return {
      generatedAt: new Date().toISOString(),
      totalRoles: roles.length,
      staffWithoutExplicitRoles: staffWithoutRoles.length,
      items: staffWithoutRoles.slice(0, 50),
    }
  }

  // ─── Transfer ───
  async exportTransfer() {
    const roles = await this.roles.list(true)
    const permissions = await this.registry.listPermissions()
    return {
      exportedAt: new Date().toISOString(),
      roles: roles.map((r) => this.roles.toDomain(r)),
      permissions,
    }
  }

  async previewTransfer(data: { roles?: unknown[]; permissions?: unknown[] }) {
    const currentRoles = await this.roles.list(true)
    const incoming = Array.isArray(data.roles) ? data.roles.length : 0
    return {
      currentRoleCount: currentRoles.length,
      incomingRoleCount: incoming,
      willCreate: Math.max(0, incoming - currentRoles.length),
      willUpdate: Math.min(incoming, currentRoles.length),
    }
  }

  async importTransfer(data: { roles?: Array<{ key: string; name: string; permissionKeys?: string[] }> }, performedBy: string) {
    let created = 0
    let updated = 0
    for (const r of data.roles ?? []) {
      const existing = await this.roles.findByKey(r.key)
      if (existing) {
        await this.roles.update(existing._id!, {
          name: r.name,
          permissionKeys: expandPermissions(r.permissionKeys ?? []),
        })
        updated++
      } else {
        await this.roles.create({
          key: r.key,
          name: r.name,
          permissionKeys: expandPermissions(r.permissionKeys ?? []),
        })
        created++
      }
    }
    await this.permAudit.append({
      entityType: 'role',
      entityId: 'import',
      entityLabel: 'bulk-import',
      action: 'update',
      changedBy: performedBy,
      summary: `Import transfer: ${created} created, ${updated} updated`,
      timestamp: new Date(),
    })
    return { created, updated }
  }

  // ─── Cache ───
  cacheStats() {
    return this.permCache.getStats()
  }

  async invalidateCache(userId?: string) {
    const count = await this.permCache.invalidate(userId)
    return { invalidated: count }
  }

  pruneCache() {
    return { pruned: this.permCache.prune() }
  }

  resetCacheStats() {
    return this.permCache.resetStats()
  }

  // ─── Bulk ───
  async executeBulk(body: {
    type: string
    items: Array<Record<string, unknown>>
    performedBy: string
  }) {
    const results: Array<{ ok: boolean; error?: string }> = []
    for (const item of body.items) {
      try {
        switch (body.type) {
          case 'assign_role':
            await this.userRoles.assign(String(item.userId), String(item.roleId), body.performedBy)
            await this.authorization.invalidateUserCache(String(item.userId))
            results.push({ ok: true })
            break
          case 'remove_role':
            await this.userRoles.remove(String(item.userId), String(item.roleId))
            await this.authorization.invalidateUserCache(String(item.userId))
            results.push({ ok: true })
            break
          case 'grant_temporal':
            await this.grantTemporal({
              userId: String(item.userId),
              permissionKeys: (item.permissionKeys as string[]) ?? [],
              reason: String(item.reason ?? 'bulk'),
              startsAt: String(item.startsAt ?? new Date().toISOString()),
              expiresAt: String(item.expiresAt ?? new Date(Date.now() + 86400000).toISOString()),
              grantedBy: body.performedBy,
            })
            results.push({ ok: true })
            break
          case 'revoke_temporals':
            if (item.id) await this.revokeTemporal(String(item.id), body.performedBy)
            results.push({ ok: true })
            break
          default:
            results.push({ ok: false, error: `Unknown bulk type: ${body.type}` })
        }
      } catch (err) {
        results.push({ ok: false, error: err instanceof Error ? err.message : 'Error' })
      }
    }
    return {
      total: body.items.length,
      succeeded: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    }
  }

  // ─── Debug ───
  async debugPermissions(userId: string) {
    const user = await this.users.findByIdSafe(userId)
    if (!user) throw AppError.notFound('Usuario no encontrado')
    const keys = await this.authorization.resolveEffectivePermissions(userId, user.role as UserRole)
    return { userId, permissionKeys: keys, count: keys.length }
  }

  async explainPermissions(userId: string) {
    const user = await this.users.findByIdSafe(userId)
    if (!user) throw AppError.notFound('Usuario no encontrado')
    return this.authorization.explainPermissions(userId, user.role as UserRole)
  }
}

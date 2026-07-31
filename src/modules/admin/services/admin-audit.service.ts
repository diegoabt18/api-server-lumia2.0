import { buildPaginationMeta, resolvePagingQuery } from '../../../common/utils/pagination.js'
import type { AuthAuditEvent, AuthAuditRepository } from '../../identity/infrastructure/auth-audit.repository.js'

export class AdminAuditService {
  constructor(private readonly authAudit: AuthAuditRepository) {}

  async list(query: Record<string, unknown>) {
    const routeQuery = query
    const { page, limit, skip, search: pagingSearch } = resolvePagingQuery(routeQuery, {
      defaultLimit: 50,
      maxLimit: 200,
    })

    const manualSearch = typeof routeQuery.search === 'string' ? routeQuery.search.trim() : ''
    const searchApplied = manualSearch || pagingSearch || undefined

    const userId = typeof routeQuery.userId === 'string' ? routeQuery.userId : undefined
    const fromRaw = routeQuery.from
    const toRaw = routeQuery.to
    const from = fromRaw ? new Date(String(fromRaw)) : undefined
    const to = toRaw ? new Date(String(toRaw)) : undefined
    const eventExact =
      !searchApplied && typeof routeQuery.event === 'string'
        ? (routeQuery.event as AuthAuditEvent)
        : undefined

    const { items, total } = await this.authAudit.query({
      userId,
      event: eventExact,
      from: from && !Number.isNaN(from.getTime()) ? from : undefined,
      to: to && !Number.isNaN(to.getTime()) ? to : undefined,
      limit,
      skip,
      search: searchApplied,
    })

    return {
      total,
      items: items.map((e) => ({
        ...e,
        timestamp: e.createdAt.toISOString(),
      })),
      pagination: buildPaginationMeta(total, page, limit),
    }
  }
}

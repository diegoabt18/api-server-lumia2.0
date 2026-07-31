export interface PaginationMeta {
  page: number
  limit: number
  total: number
  totalPages: number
  hasNext: boolean
  hasPrev: boolean
}

export function buildPaginationMeta(total: number, page: number, limit: number): PaginationMeta {
  const totalPages = Math.max(1, Math.ceil(total / limit))
  return {
    page,
    limit,
    total,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1,
  }
}

export function resolvePagingQuery(
  query: Record<string, unknown>,
  opts: { defaultLimit?: number; maxLimit?: number } = {},
): { page: number; limit: number; skip: number; search: string } {
  const defaultLimit = opts.defaultLimit ?? 20
  const maxLimit = opts.maxLimit ?? 100
  const page = Math.max(1, Number(query.page ?? 1) || 1)
  let limit = Number(query.limit ?? defaultLimit) || defaultLimit
  limit = Math.min(Math.max(1, limit), maxLimit)
  const skip = (page - 1) * limit
  const search = typeof query.search === 'string' ? query.search.trim() : ''
  return { page, limit, skip, search }
}

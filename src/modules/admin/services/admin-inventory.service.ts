import { buildPaginationMeta, resolvePagingQuery } from '../../../common/utils/pagination.js'
import type { InventoryRepository } from '../../catalog/infrastructure/inventory.repository.js'

export class AdminInventoryService {
  constructor(private readonly inventory: InventoryRepository) {}

  async list(query: Record<string, unknown>) {
    const { page, limit, skip, search } = resolvePagingQuery(query, { defaultLimit: 50, maxLimit: 200 })
    const { items, total } = await this.inventory.listAdmin(skip, limit, search || undefined)
    return { items, pagination: buildPaginationMeta(total, page, limit) }
  }

  async upsertBySku(
    sku: string,
    data: { quantity: number; reserved?: number; warehouse?: string; is_per_order?: boolean },
  ) {
    await this.inventory.upsertBySku({ sku, ...data })
    return { ok: true }
  }
}

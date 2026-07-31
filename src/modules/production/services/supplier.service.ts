import { AppError } from '../../../common/errors/app.error.js'
import { resolvePagingQuery } from '../../../common/utils/pagination.js'
import type { SupplierRepository } from '../infrastructure/supplier.repository.js'

export class SupplierService {
  constructor(private readonly suppliers: SupplierRepository) {}

  async list(query: Record<string, unknown>) {
    const { page, limit, skip, search } = resolvePagingQuery(query, { defaultLimit: 50, maxLimit: 200 })
    const activeOnly = query.activeOnly === true || query.activeOnly === 'true'
    const [items, total] = await Promise.all([
      this.suppliers.list(limit, skip, search || undefined, activeOnly),
      this.suppliers.countAll(search || undefined, activeOnly),
    ])
    return {
      data: items,
      meta: { total, page, pageSize: limit, totalPages: Math.ceil(total / limit) || 1 },
    }
  }

  async get(id: string) {
    const supplier = await this.suppliers.getById(id)
    if (!supplier) throw AppError.notFound('Proveedor no encontrado')
    return { success: true as const, data: supplier }
  }

  async create(input: Record<string, unknown>) {
    if (!String(input.name ?? '').trim()) throw AppError.badRequest('El nombre es requerido')
    const supplier = await this.suppliers.create(input as never)
    return { success: true as const, data: supplier }
  }

  async update(id: string, patch: Record<string, unknown>) {
    const updated = await this.suppliers.update(id, patch)
    if (!updated) throw AppError.notFound('Proveedor no encontrado')
    return { success: true as const, data: updated }
  }

  async delete(id: string) {
    const ok = await this.suppliers.deleteSupplier(id)
    if (!ok) throw AppError.notFound('Proveedor no encontrado')
    return { success: true as const }
  }
}

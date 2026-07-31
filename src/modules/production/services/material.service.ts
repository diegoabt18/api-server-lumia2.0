import { ObjectId } from 'mongodb'
import { AppError } from '../../../common/errors/app.error.js'
import { resolvePagingQuery } from '../../../common/utils/pagination.js'
import { validateMaterialInput } from '../domain/material.entity.js'
import { calculateUnitCost } from '../domain/value-objects/cost-breakdown.vo.js'
import type { MaterialRepository } from '../infrastructure/material.repository.js'
import type { ProductionAuditRepository } from '../infrastructure/production-audit.repository.js'
import type { RecipeRepository } from '../infrastructure/recipe.repository.js'

export class MaterialService {
  constructor(
    private readonly materials: MaterialRepository,
    private readonly recipes: RecipeRepository,
    private readonly audit: ProductionAuditRepository,
  ) {}

  async list(query: Record<string, unknown>) {
    const { page, limit, skip, search } = resolvePagingQuery(query, { defaultLimit: 20, maxLimit: 100 })
    const category = typeof query.category === 'string' ? query.category : undefined
    const activeOnly = query.activeOnly === true || query.activeOnly === 'true'
    const idsParam = typeof query.ids === 'string' ? query.ids : undefined

    if (idsParam) {
      const ids = idsParam.split(',').map((s) => s.trim()).filter(Boolean)
      const items = await this.materials.getByIds(ids)
      return {
        data: items,
        meta: { total: items.length, page: 1, pageSize: items.length, totalPages: 1 },
      }
    }

    const [items, total] = await Promise.all([
      this.materials.list(limit, skip, search || undefined, category, activeOnly),
      this.materials.countAll(search || undefined, category, activeOnly),
    ])

    return {
      data: items,
      meta: {
        total,
        page,
        pageSize: limit,
        totalPages: Math.ceil(total / limit) || 1,
      },
    }
  }

  async get(id: string) {
    const material = await this.materials.getById(id)
    if (!material) throw AppError.notFound('Material no encontrado')
    return { success: true as const, data: material }
  }

  async create(input: Record<string, unknown>, userId: string) {
    validateMaterialInput(input as { name: string; category: string })
    const existing = await this.materials.getByName(String(input.name))
    if (existing) throw AppError.conflict(`Ya existe un material con el nombre "${input.name}"`)

    const material = await this.materials.create(input as never)
    await this.audit.insert({
      event_type: 'material_updated',
      entity_type: 'material',
      entity_id: material.id,
      description: `Material creado: ${material.name}`,
      new_value: material,
      performed_by: ObjectId.isValid(userId) ? new ObjectId(userId) : userId,
      created_at: new Date(),
    })
    return { success: true as const, data: material }
  }

  async update(id: string, patch: Record<string, unknown>, userId: string) {
    const prev = await this.materials.getById(id)
    if (!prev) throw AppError.notFound('Material no encontrado')

    const updated = await this.materials.update(id, patch)
    if (!updated) throw AppError.notFound('Material no encontrado')

    await this.audit.insert({
      event_type: 'material_updated',
      entity_type: 'material',
      entity_id: id,
      description: `Material actualizado: ${updated.name}`,
      previous_value: prev,
      new_value: updated,
      performed_by: ObjectId.isValid(userId) ? new ObjectId(userId) : userId,
      created_at: new Date(),
    })
    return { success: true as const, data: updated }
  }

  async delete(id: string) {
    const count = await this.recipes.countUsingMaterial(id)
    if (count > 0) {
      throw AppError.conflict(`No se puede eliminar: el material está siendo usado en ${count} receta(s)`)
    }
    const ok = await this.materials.deleteMaterial(id)
    if (!ok) throw AppError.notFound('Material no encontrado')
    return { success: true as const }
  }

  async listPriceHistory(materialId: string) {
    const material = await this.materials.getById(materialId)
    if (!material) throw AppError.notFound('Material no encontrado')
    const data = await this.materials.listPriceHistory(materialId)
    return { data }
  }

  async registerPrice(materialId: string, input: Record<string, unknown>, userId: string) {
    const material = await this.materials.getById(materialId)
    if (!material) throw AppError.notFound('Material no encontrado')

    const price = Number(input.price)
    const quantity = Number(input.quantity)
    const unit = String(input.unit)
    const rolloMeters = input.rolloMeters != null ? Number(input.rolloMeters) : undefined

    const unitCost = calculateUnitCost(price, quantity)
    let effectiveUnitCost = unitCost
    let storedRolloMeters: number | null = null

    if (unit === 'rollo' && rolloMeters && rolloMeters > 0) {
      storedRolloMeters = rolloMeters
      effectiveUnitCost = unitCost / rolloMeters
    }

    const entry = await this.materials.createPriceEntry({
      material_id: new ObjectId(materialId),
      price,
      quantity,
      unit: unit as never,
      rollo_meters: storedRolloMeters,
      unit_cost: effectiveUnitCost,
      supplier_id: input.supplierId && ObjectId.isValid(String(input.supplierId))
        ? new ObjectId(String(input.supplierId))
        : null,
      supplier_name: input.supplierName ? String(input.supplierName) : null,
      notes: input.notes ? String(input.notes) : null,
      invoice_number: input.invoiceNumber ? String(input.invoiceNumber) : null,
      recorded_by: ObjectId.isValid(userId) ? new ObjectId(userId) : userId,
      recorded_at: new Date(),
    })

    if (unit === 'rollo' && storedRolloMeters) {
      await this.materials.updateLastCost(materialId, effectiveUnitCost, 'm', storedRolloMeters)
    } else {
      await this.materials.updateLastCost(materialId, unitCost, unit)
    }

    await this.recipes.markOutdatedByMaterialId(materialId)
    await this.audit.insert({
      event_type: 'material_price_changed',
      entity_type: 'material',
      entity_id: materialId,
      description: `Precio registrado para ${material.name}`,
      new_value: entry,
      performed_by: ObjectId.isValid(userId) ? new ObjectId(userId) : userId,
      created_at: new Date(),
    })

    return { success: true as const, data: entry }
  }
}

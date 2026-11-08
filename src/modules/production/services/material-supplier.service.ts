import { ObjectId } from 'mongodb'
import { AppError } from '../../../common/errors/app.error.js'
import type { MaterialRepository } from '../infrastructure/material.repository.js'
import type { SupplierRepository } from '../infrastructure/supplier.repository.js'
import type { MaterialSupplierRepository } from '../infrastructure/material-supplier.repository.js'

/** Proveedores enlazados a un material. Valida existencia antes de escribir. */
export class MaterialSupplierService {
  constructor(
    private readonly materials: MaterialRepository,
    private readonly suppliers: SupplierRepository,
    private readonly links: MaterialSupplierRepository,
  ) {}

  private async requireMaterial(materialId: string) {
    if (!ObjectId.isValid(materialId)) throw AppError.badRequest('ID de material inválido')
    const material = await this.materials.getById(materialId)
    if (!material) throw AppError.notFound('Material no encontrado')
  }

  async list(materialId: string) {
    return this.links.listForMaterial(materialId)
  }

  async link(materialId: string, supplierId: string, isPreferred: boolean) {
    await this.requireMaterial(materialId)
    if (!ObjectId.isValid(supplierId)) throw AppError.notFound('Proveedor no encontrado')
    const supplier = await this.suppliers.getById(supplierId)
    if (!supplier) throw AppError.notFound('Proveedor no encontrado')
    await this.links.link(materialId, supplierId, isPreferred)
    return { success: true as const, data: { suppliers: await this.links.listForMaterial(materialId) } }
  }

  async unlink(materialId: string, supplierId: string) {
    await this.requireMaterial(materialId)
    await this.links.unlink(materialId, supplierId)
    return { success: true as const, data: { suppliers: await this.links.listForMaterial(materialId) } }
  }
}

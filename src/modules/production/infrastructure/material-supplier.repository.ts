import { ObjectId, type Db } from 'mongodb'

/**
 * Enlaces material ↔ proveedor (production_db.material_suppliers). Mismo almacenamiento que usaba
 * el backend embebido de Lumia (ObjectId en material_id y supplier_id), para no migrar datos.
 */
export interface MaterialSupplierLink {
  supplierId: string
  supplierName: string
  isPreferred: boolean
}

export class MaterialSupplierRepository {
  constructor(private readonly db: Db) {}

  private links() {
    return this.db.collection('material_suppliers')
  }

  async listForMaterial(materialId: string): Promise<MaterialSupplierLink[]> {
    if (!ObjectId.isValid(materialId)) return []
    const docs = await this.links().find({ material_id: new ObjectId(materialId) }).toArray()
    if (!docs.length) return []
    const supplierIds = docs.map((d) => d.supplier_id as ObjectId).filter(Boolean)
    const suppliers = await this.db
      .collection('suppliers')
      .find({ _id: { $in: supplierIds } }, { projection: { name: 1 } })
      .toArray()
    const names = new Map(suppliers.map((s) => [String(s._id), String(s.name ?? '')]))
    return docs.map((d) => ({
      supplierId: String(d.supplier_id),
      supplierName: names.get(String(d.supplier_id)) ?? '',
      isPreferred: d.is_preferred === true,
    }))
  }

  async link(materialId: string, supplierId: string, isPreferred: boolean): Promise<void> {
    const material = new ObjectId(materialId)
    const supplier = new ObjectId(supplierId)
    await this.links().updateOne(
      { material_id: material, supplier_id: supplier },
      { $set: { material_id: material, supplier_id: supplier, is_preferred: isPreferred } },
      { upsert: true },
    )
  }

  async unlink(materialId: string, supplierId: string): Promise<void> {
    if (!ObjectId.isValid(materialId) || !ObjectId.isValid(supplierId)) return
    await this.links().deleteOne({
      material_id: new ObjectId(materialId),
      supplier_id: new ObjectId(supplierId),
    })
  }
}

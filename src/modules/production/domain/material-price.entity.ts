import type { UnitOfMeasure } from './value-objects/unit-of-measure.vo.js'

export interface MaterialPriceEntity {
  _id?: unknown
  material_id: unknown
  price: number
  quantity: number
  unit: UnitOfMeasure
  rollo_meters?: number | null
  unit_cost: number
  supplier_id?: unknown | null
  supplier_name?: string | null
  notes?: string | null
  invoice_number?: string | null
  recorded_by: unknown
  recorded_at: Date
}

export interface MaterialPriceDomain {
  id: string
  materialId: string
  price: number
  quantity: number
  unit: UnitOfMeasure
  rolloMeters?: number | null
  unitCost: number
  supplierId?: string | null
  supplierName?: string | null
  notes?: string | null
  invoiceNumber?: string | null
  recordedBy: string
  recordedAt: string
}

export function toMaterialPriceDomain(
  entity: MaterialPriceEntity & { _id?: { toString(): string } },
): MaterialPriceDomain {
  return {
    id: entity._id?.toString?.() ?? '',
    materialId: (entity.material_id as { toString?: () => string })?.toString?.() ?? '',
    price: entity.price,
    quantity: entity.quantity,
    unit: entity.unit,
    rolloMeters: entity.rollo_meters,
    unitCost: entity.unit_cost,
    supplierId: (entity.supplier_id as { toString?: () => string } | null)?.toString?.() ?? entity.supplier_id as string | null,
    supplierName: entity.supplier_name,
    notes: entity.notes,
    invoiceNumber: entity.invoice_number,
    recordedBy: (entity.recorded_by as { toString?: () => string })?.toString?.() ?? '',
    recordedAt: entity.recorded_at?.toISOString?.() ?? '',
  }
}

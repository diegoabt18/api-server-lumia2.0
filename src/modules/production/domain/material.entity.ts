import type { MaterialCategory } from './value-objects/material-category.vo.js'
import { isValidMaterialCategory } from './value-objects/material-category.vo.js'
import type { UnitOfMeasure } from './value-objects/unit-of-measure.vo.js'

export interface MaterialEntity {
  _id?: unknown
  name: string
  code?: string
  category: MaterialCategory
  description?: string
  image_path?: string
  active: boolean
  purchase_unit: UnitOfMeasure
  last_cost: number
  last_cost_unit: UnitOfMeasure
  /** @deprecated Preferir content_unit + content_quantity */
  roll_meters?: number
  content_unit?: string
  content_quantity?: number
  stock_enabled: boolean
  stock_current?: number
  stock_minimum?: number
  stock_unit?: UnitOfMeasure
  created_at: Date
  updated_at: Date
}

export interface MaterialDomain {
  id: string
  name: string
  code?: string
  category: MaterialCategory
  description?: string
  imagePath?: string
  active: boolean
  purchaseUnit: UnitOfMeasure
  lastCost: number
  lastCostUnit: UnitOfMeasure
  /** @deprecated Preferir contentUnit + contentQuantity */
  rollMeters?: number
  contentUnit?: string
  contentQuantity?: number
  stockEnabled: boolean
  stockCurrent?: number
  stockMinimum?: number
  stockUnit?: UnitOfMeasure
  createdAt: string
  updatedAt: string
}

export function toMaterialDomain(entity: MaterialEntity & { _id?: { toString(): string } }): MaterialDomain {
  return {
    id: entity._id?.toString?.() ?? '',
    name: entity.name,
    code: entity.code,
    category: entity.category,
    description: entity.description,
    imagePath: entity.image_path,
    active: entity.active,
    purchaseUnit: entity.purchase_unit,
    lastCost: entity.last_cost,
    lastCostUnit: entity.last_cost_unit,
    rollMeters: entity.roll_meters,
    contentUnit: entity.content_unit,
    contentQuantity: entity.content_quantity,
    stockEnabled: entity.stock_enabled,
    stockCurrent: entity.stock_current,
    stockMinimum: entity.stock_minimum,
    stockUnit: entity.stock_unit,
    createdAt: entity.created_at?.toISOString?.() ?? '',
    updatedAt: entity.updated_at?.toISOString?.() ?? '',
  }
}

export function toMaterialEntity(input: {
  name: string
  code?: string
  category: MaterialCategory
  description?: string
  imagePath?: string
  active?: boolean
  purchaseUnit: UnitOfMeasure
  lastCost?: number
  lastCostUnit?: UnitOfMeasure
  rollMeters?: number
  contentUnit?: string
  contentQuantity?: number
  stockEnabled?: boolean
  stockCurrent?: number
  stockMinimum?: number
  stockUnit?: UnitOfMeasure
}): Omit<MaterialEntity, '_id'> {
  const now = new Date()
  const defaultUnit = input.purchaseUnit
  const contentUnit = input.contentUnit?.trim() || undefined
  const contentQuantity =
    input.contentQuantity != null && input.contentQuantity > 0 ? input.contentQuantity : undefined
  const rollMeters =
    input.purchaseUnit === 'rollo'
      ? (input.rollMeters ?? (contentUnit === 'm' ? contentQuantity : undefined))
      : undefined
  return {
    name: input.name.trim(),
    code: input.code?.trim(),
    category: input.category,
    description: input.description?.trim(),
    image_path: input.imagePath?.trim() || undefined,
    active: input.active ?? true,
    purchase_unit: input.purchaseUnit,
    last_cost: input.lastCost ?? 0,
    last_cost_unit: input.lastCostUnit ?? defaultUnit,
    roll_meters: rollMeters,
    content_unit: contentUnit,
    content_quantity: contentQuantity,
    stock_enabled: input.stockEnabled ?? false,
    stock_current: input.stockCurrent,
    stock_minimum: input.stockMinimum,
    stock_unit: input.stockUnit,
    created_at: now,
    updated_at: now,
  }
}

export function validateMaterialInput(input: { name: string; category: string }): void {
  if (!input.name?.trim()) throw new Error('El nombre del material es requerido')
  if (!isValidMaterialCategory(input.category)) {
    throw new Error(`Categoría inválida: "${input.category}"`)
  }
}

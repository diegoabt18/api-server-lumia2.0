/**
 * Motor único de costeo de consumo de material.
 * Espejo de lumia/shared/production/unit-cost-engine — mantener sincronizado.
 */

import {
  assertMaterialContentConfigured,
  isCommercialUnit,
  isCountBaseUnit,
  resolveMaterialContent,
  type MaterialContentInput,
} from './material-content.js'
import {
  convertPhysical,
  isPhysicalUnit,
  UnitConversionError,
} from './physical-units.js'

export interface RecipeConsumptionInput {
  quantity: number
  unit: string
  rolloMeters?: number | null
}

export interface MaterialConsumptionCostResult {
  cost: number
  quantityInContentUnit: number
  contentUnit: string
  costPerContentUnit: number
  purchaseUnit: string
  pricePerPurchaseUnit: number
}

function normalizeLegacyRollCost(mat: MaterialContentInput): number {
  const cost = Math.max(mat.lastCost, 0)
  if (mat.purchaseUnit === 'rollo' && mat.lastCostUnit === 'm') {
    const resolved = resolveMaterialContent(mat)
    const meters = resolved.contentQuantity
    if (meters && meters > 0) return cost * meters
  }
  return cost
}

export function calculateMaterialConsumptionCost(
  mat: MaterialContentInput,
  line: RecipeConsumptionInput,
): MaterialConsumptionCostResult {
  if (!Number.isFinite(line.quantity) || line.quantity < 0) {
    throw new UnitConversionError('La cantidad de receta debe ser un número ≥ 0')
  }
  if (line.quantity === 0 || mat.lastCost <= 0) {
    return {
      cost: 0,
      quantityInContentUnit: 0,
      contentUnit: mat.purchaseUnit,
      costPerContentUnit: 0,
      purchaseUnit: mat.purchaseUnit,
      pricePerPurchaseUnit: Math.max(mat.lastCost, 0),
    }
  }

  const matWithLine: MaterialContentInput = {
    ...mat,
    rollMeters: mat.rollMeters ?? line.rolloMeters ?? null,
  }

  const resolved = resolveMaterialContent(matWithLine)
  const pricePerPurchase = normalizeLegacyRollCost(matWithLine)

  if (resolved.isDirectPurchase) {
    if (line.unit === resolved.purchaseUnit) {
      return {
        cost: line.quantity * pricePerPurchase,
        quantityInContentUnit: line.quantity,
        contentUnit: resolved.purchaseUnit,
        costPerContentUnit: pricePerPurchase,
        purchaseUnit: resolved.purchaseUnit,
        pricePerPurchaseUnit: pricePerPurchase,
      }
    }

    if (isPhysicalUnit(resolved.purchaseUnit) && isPhysicalUnit(line.unit)) {
      const qtyInPurchase = convertPhysical(line.quantity, line.unit, resolved.purchaseUnit)
      return {
        cost: qtyInPurchase * pricePerPurchase,
        quantityInContentUnit: qtyInPurchase,
        contentUnit: resolved.purchaseUnit,
        costPerContentUnit: pricePerPurchase,
        purchaseUnit: resolved.purchaseUnit,
        pricePerPurchaseUnit: pricePerPurchase,
      }
    }

    throw new UnitConversionError(
      `No se puede convertir ${line.unit} a ${resolved.purchaseUnit} para este material.`,
    )
  }

  assertMaterialContentConfigured(resolved)
  const contentUnit = resolved.contentUnit!
  const contentQty = resolved.contentQuantity!
  const costPerContent = pricePerPurchase / contentQty

  if (line.unit === resolved.purchaseUnit) {
    return {
      cost: line.quantity * pricePerPurchase,
      quantityInContentUnit: line.quantity * contentQty,
      contentUnit,
      costPerContentUnit: costPerContent,
      purchaseUnit: resolved.purchaseUnit,
      pricePerPurchaseUnit: pricePerPurchase,
    }
  }

  let qtyInContent: number
  if (line.unit === contentUnit) {
    qtyInContent = line.quantity
  } else if (isPhysicalUnit(line.unit) && isPhysicalUnit(contentUnit)) {
    qtyInContent = convertPhysical(line.quantity, line.unit, contentUnit)
  } else if (isCountBaseUnit(line.unit) && isCountBaseUnit(contentUnit)) {
    qtyInContent = line.quantity
  } else {
    throw new UnitConversionError(
      `No existe una equivalencia entre ${resolved.purchaseUnit} y ${line.unit} para este material. ` +
        `El contenido configurado es ${contentQty} ${contentUnit} por ${resolved.purchaseUnit}.`,
    )
  }

  return {
    cost: qtyInContent * costPerContent,
    quantityInContentUnit: qtyInContent,
    contentUnit,
    costPerContentUnit: costPerContent,
    purchaseUnit: resolved.purchaseUnit,
    pricePerPurchaseUnit: pricePerPurchase,
  }
}

export function calculateMaterialConsumptionCostAmount(
  mat: MaterialContentInput,
  line: RecipeConsumptionInput,
): number {
  return calculateMaterialConsumptionCost(mat, line).cost
}

export function requiresMaterialContent(purchaseUnit: string): boolean {
  return isCommercialUnit(purchaseUnit)
}

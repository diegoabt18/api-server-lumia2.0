/**
 * Presentaciones comerciales: contenido por MATERIAL.
 * Espejo de lumia/shared/production/unit-cost-engine — mantener sincronizado.
 */

import {
  getPhysicalFamily,
  isPhysicalUnit,
  PHYSICAL_UNIT_IDS,
  UnitConversionError,
} from './physical-units.js'

export const COMMERCIAL_UNITS = ['caja', 'bolsa', 'paquete', 'rollo', 'pliego'] as const
export type CommercialUnitId = (typeof COMMERCIAL_UNITS)[number]

export const COUNT_BASE_UNIT = 'unidad' as const

export function isCommercialUnit(unit: string): unit is CommercialUnitId {
  return (COMMERCIAL_UNITS as readonly string[]).includes(unit)
}

export function isCountBaseUnit(unit: string): boolean {
  return unit === COUNT_BASE_UNIT
}

export interface MaterialContentInput {
  purchaseUnit: string
  lastCost: number
  lastCostUnit?: string
  contentUnit?: string | null
  contentQuantity?: number | null
  /** @deprecated Preferir contentUnit='m' + contentQuantity */
  rollMeters?: number | null
}

export interface ResolvedMaterialContent {
  purchaseUnit: string
  isDirectPurchase: boolean
  contentUnit: string | null
  contentQuantity: number | null
}

export function resolveMaterialContent(mat: MaterialContentInput): ResolvedMaterialContent {
  const purchaseUnit = mat.purchaseUnit

  if (isPhysicalUnit(purchaseUnit) || isCountBaseUnit(purchaseUnit)) {
    return {
      purchaseUnit,
      isDirectPurchase: true,
      contentUnit: null,
      contentQuantity: null,
    }
  }

  if (!isCommercialUnit(purchaseUnit)) {
    throw new UnitConversionError(
      `Unidad de compra "${purchaseUnit}" no soportada. Usa una unidad física, unidad, o presentación comercial (caja, bolsa, paquete, rollo, pliego).`,
    )
  }

  let contentUnit = mat.contentUnit?.trim() || null
  let contentQuantity =
    mat.contentQuantity != null && mat.contentQuantity > 0 ? mat.contentQuantity : null

  if ((!contentUnit || !contentQuantity) && purchaseUnit === 'rollo') {
    const rm = mat.rollMeters != null && mat.rollMeters > 0 ? mat.rollMeters : null
    if (rm) {
      contentUnit = 'm'
      contentQuantity = rm
    }
  }

  return {
    purchaseUnit,
    isDirectPurchase: false,
    contentUnit,
    contentQuantity,
  }
}

export function assertMaterialContentConfigured(resolved: ResolvedMaterialContent): void {
  if (resolved.isDirectPurchase) return
  if (!resolved.contentUnit || !resolved.contentQuantity || resolved.contentQuantity <= 0) {
    throw new UnitConversionError(
      `No existe una equivalencia entre ${resolved.purchaseUnit} y su contenido para este material. ` +
        `Configura el contenido de la presentación (unidad y cantidad) en el material.`,
    )
  }
}

export function getAllowedRecipeUnitsForMaterial(mat: MaterialContentInput): string[] {
  const resolved = resolveMaterialContent(mat)
  const purchase = resolved.purchaseUnit

  if (resolved.isDirectPurchase) {
    if (isPhysicalUnit(purchase)) {
      const family = getPhysicalFamily(purchase)
      return PHYSICAL_UNIT_IDS.filter((u) => getPhysicalFamily(u) === family)
    }
    return [COUNT_BASE_UNIT]
  }

  assertMaterialContentConfigured(resolved)
  const content = resolved.contentUnit!
  const allowed = new Set<string>([purchase])

  if (isPhysicalUnit(content)) {
    const family = getPhysicalFamily(content)
    for (const u of PHYSICAL_UNIT_IDS) {
      if (getPhysicalFamily(u) === family) allowed.add(u)
    }
  } else if (isCountBaseUnit(content)) {
    allowed.add(COUNT_BASE_UNIT)
  } else {
    allowed.add(content)
  }

  return [...allowed]
}

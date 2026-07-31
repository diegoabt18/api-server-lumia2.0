/**
 * Módulo Production — Fase 5 MVP (producción y costeo).
 * Colecciones en production_db.
 */
import type { MaterialRepository } from './infrastructure/material.repository.js'
import type { RecipeRepository } from './infrastructure/recipe.repository.js'
import type { SupplierRepository } from './infrastructure/supplier.repository.js'
import type { UnitRepository } from './infrastructure/unit.repository.js'

export const PRODUCTION_COLLECTIONS = [
  'materials',
  'material_price_history',
  'suppliers',
  'recipes',
  'production_config',
  'production_audit_log',
  'unit_of_measures',
] as const

export interface ProductionModuleStatus {
  status: 'active'
  collections: string[]
  counts: {
    materials: number
    suppliers: number
    recipes: number
    units: number
  }
}

export interface ProductionStatusRepos {
  materials: MaterialRepository
  suppliers: SupplierRepository
  recipes: RecipeRepository
  units: UnitRepository
}

export async function getProductionModuleStatus(repos: ProductionStatusRepos): Promise<ProductionModuleStatus> {
  const [materials, suppliers, recipes, units] = await Promise.all([
    repos.materials.countAll(),
    repos.suppliers.countAll(),
    repos.recipes.countAll(),
    repos.units.list().then((list) => list.length),
  ])

  return {
    status: 'active',
    collections: [...PRODUCTION_COLLECTIONS],
    counts: { materials, suppliers, recipes, units },
  }
}

export { MATERIAL_CATEGORY, ALL_MATERIAL_CATEGORIES } from './domain/value-objects/material-category.vo.js'
export { UNIT_OF_MEASURE, ALL_UNITS } from './domain/value-objects/unit-of-measure.vo.js'

export {
  PHYSICAL_UNITS,
  PHYSICAL_UNIT_IDS,
  convertPhysical,
  isPhysicalUnit,
  getPhysicalFamily,
  assertSamePhysicalFamily,
  UnitConversionError,
  type PhysicalFamily,
  type PhysicalUnitId,
} from './physical-units.js'

export {
  COMMERCIAL_UNITS,
  COUNT_BASE_UNIT,
  isCommercialUnit,
  isCountBaseUnit,
  resolveMaterialContent,
  assertMaterialContentConfigured,
  getAllowedRecipeUnitsForMaterial,
  type CommercialUnitId,
  type MaterialContentInput,
  type ResolvedMaterialContent,
} from './material-content.js'

export {
  calculateMaterialConsumptionCost,
  calculateMaterialConsumptionCostAmount,
  requiresMaterialContent,
  type RecipeConsumptionInput,
  type MaterialConsumptionCostResult,
} from './cost-engine.js'

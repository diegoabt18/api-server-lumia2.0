import { z } from 'zod'

export const materialCategorySchema = z.enum([
  'ceras', 'parafinas', 'fragancias', 'colorantes', 'pabilos',
  'cementos', 'aditivos', 'pegantes', 'cartones', 'papeles',
  'envases', 'empaques', 'decoraciones', 'otros',
])

export const unitOfMeasureSchema = z.enum([
  'kg', 'g', 'mg', 'l', 'ml', 'm', 'cm', 'mm', 'm2', 'cm2',
  'unidad', 'pliego', 'rollo', 'caja', 'bolsa', 'paquete', 'otro',
])

export const createMaterialSchema = z.object({
  name: z.string().min(1).max(200),
  code: z.string().max(100).optional(),
  category: materialCategorySchema,
  description: z.string().max(2000).optional(),
  imagePath: z.string().max(500).optional(),
  active: z.boolean().optional(),
  purchaseUnit: unitOfMeasureSchema,
  lastCost: z.number().min(0).optional(),
  lastCostUnit: unitOfMeasureSchema.optional(),
  rollMeters: z.number().int().positive().optional(),
  stockEnabled: z.boolean().optional(),
  stockCurrent: z.number().min(0).optional(),
  stockMinimum: z.number().min(0).optional(),
  stockUnit: unitOfMeasureSchema.optional(),
})

export const updateMaterialSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  code: z.string().max(100).optional().nullable(),
  category: materialCategorySchema.optional(),
  description: z.string().max(2000).optional().nullable(),
  imagePath: z.string().max(500).optional().nullable(),
  active: z.boolean().optional(),
  purchaseUnit: unitOfMeasureSchema.optional(),
  rollMeters: z.number().int().positive().optional().nullable(),
  stockEnabled: z.boolean().optional(),
  stockCurrent: z.number().min(0).optional().nullable(),
  stockMinimum: z.number().min(0).optional().nullable(),
  stockUnit: unitOfMeasureSchema.optional().nullable(),
})

export const createMaterialPriceSchema = z.object({
  price: z.number().min(0.01),
  quantity: z.number().min(0.01),
  unit: unitOfMeasureSchema,
  rolloMeters: z.number().min(0.01).optional(),
  supplierId: z.string().optional(),
  supplierName: z.string().max(200).optional(),
  notes: z.string().max(500).optional(),
  invoiceNumber: z.string().max(100).optional(),
})

export const createSupplierSchema = z.object({
  name: z.string().min(1).max(200),
  contactName: z.string().max(200).optional(),
  phone: z.string().max(50).optional(),
  email: z.string().email().optional().or(z.literal('')),
  notes: z.string().max(1000).optional(),
  isFavorite: z.boolean().optional(),
  active: z.boolean().optional(),
})

export const updateSupplierSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  contactName: z.string().max(200).optional().nullable(),
  phone: z.string().max(50).optional().nullable(),
  email: z.string().email().optional().nullable().or(z.literal('')),
  notes: z.string().max(1000).optional().nullable(),
  isFavorite: z.boolean().optional(),
  active: z.boolean().optional(),
})

export const recipeLineSchema = z.object({
  materialId: z.string().min(1).optional(),
  materialName: z.string().min(1),
  materialCode: z.string().optional(),
  rolloMeters: z.number().min(0.01).optional(),
  unit: unitOfMeasureSchema,
  quantity: z.number().min(0.001),
})

export const indirectCostSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['fixed', 'percentage']),
  value: z.number().min(0),
  optional: z.boolean().default(true),
})

export const createRecipeSchema = z.object({
  name: z.string().min(1),
  productSlug: z.string().min(1),
  productName: z.string().optional(),
  variantSku: z.string().optional(),
  lines: z.array(recipeLineSchema).min(1),
  indirectCosts: z.array(indirectCostSchema).optional(),
  marginPercentage: z.number().min(0).max(1000).optional(),
  pricingMode: z.enum(['auto_margin', 'fixed_margin', 'manual']).optional(),
  manualPrice: z.number().min(0).optional(),
})

export const updateRecipeSchema = z.object({
  name: z.string().min(1).optional(),
  productSlug: z.string().min(1).optional(),
  variantSku: z.string().optional().nullable(),
  active: z.boolean().optional(),
  lines: z.array(recipeLineSchema).min(1).optional(),
  indirectCosts: z.array(indirectCostSchema).optional(),
  marginPercentage: z.number().min(0).max(1000).optional().nullable(),
  pricingMode: z.enum(['auto_margin', 'fixed_margin', 'manual']).optional(),
  manualPrice: z.number().min(0).optional().nullable(),
  suggestedPrice: z.number().min(0).optional().nullable(),
  actualPrice: z.number().min(0).optional().nullable(),
  changesDescription: z.string().max(500).optional(),
})

export const calculateCostSchema = z.object({
  recipeId: z.string().min(1),
})

export const updateProductionConfigSchema = z.object({
  defaultMarginPercentage: z.number().min(0).max(1000).optional(),
  currency: z.string().min(1).max(10).optional(),
  decimalPlaces: z.number().min(0).max(10).optional(),
  priceRounding: z.number().min(1).optional(),
  defaultIndirectCosts: z.array(indirectCostSchema).optional(),
  taxPercentage: z.number().min(0).max(100).optional().nullable(),
  minimumProfitPercentage: z.number().min(0).max(1000).optional(),
  suggestedProfitPercentage: z.number().min(0).max(1000).optional(),
  premiumProfitPercentage: z.number().min(0).max(1000).optional(),
  wholesaleProfitPercentage: z.number().min(0).max(1000).optional(),
  distributorProfitPercentage: z.number().min(0).max(1000).optional(),
  psychologicalRounding: z.number().min(1).optional(),
  defaultLaborCostPerHour: z.number().min(0).optional(),
  defaultEnergyCostPerHour: z.number().min(0).optional(),
  globalWastePercent: z.number().min(0).max(100).optional(),
})

export const unitFamilySchema = z.enum(['mass', 'volume', 'length', 'area', 'count', 'other'])

export const createUnitSchema = z.object({
  name: z.string().min(1).max(100),
  abbreviation: z.string().min(1).max(20),
  family: unitFamilySchema,
  baseFactor: z.number().positive(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
})

export const updateUnitSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  abbreviation: z.string().min(1).max(20).optional(),
  family: unitFamilySchema.optional(),
  baseFactor: z.number().positive().optional(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
})

export const productionAuditQuerySchema = z.object({
  eventType: z.string().optional(),
  entityType: z.string().optional(),
  entityId: z.string().optional(),
  performedBy: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
})

export const createUnitEquivalenceSchema = z.object({
  fromUnitId: z.string().min(1),
  toUnitId: z.string().min(1),
  factor: z.number().positive(),
  description: z.string().max(500).optional(),
  active: z.boolean().optional(),
})

export const updateUnitEquivalenceSchema = z.object({
  fromUnitId: z.string().min(1).optional(),
  toUnitId: z.string().min(1).optional(),
  factor: z.number().positive().optional(),
  description: z.string().max(500).optional().nullable(),
  active: z.boolean().optional(),
})

export const indirectCostAllocationSchema = z.enum([
  'per_unit', 'per_batch', 'per_hour', 'percentage', 'per_direct_cost',
])

export const createGlobalIndirectCostSchema = z.object({
  name: z.string().min(1).max(200),
  allocationType: indirectCostAllocationSchema,
  value: z.number().min(0),
  active: z.boolean().optional(),
  notes: z.string().max(500).optional(),
})

export const updateGlobalIndirectCostSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  allocationType: indirectCostAllocationSchema.optional(),
  value: z.number().min(0).optional(),
  active: z.boolean().optional(),
  notes: z.string().max(500).optional().nullable(),
})

export const approvalIdsSchema = z.object({
  approvalIds: z.array(z.string().min(1)).min(1),
})

export const rejectApprovalSchema = z.object({
  approvalIds: z.array(z.string().min(1)).min(1),
  reason: z.string().min(1).max(500),
})

export const suggestPriceSchema = z.object({
  totalCost: z.number().min(0),
  marginPercentage: z.number().min(0).max(1000),
  rounding: z.number().min(1).optional(),
  currency: z.string().min(1).max(10).optional(),
})

export const unitConvertSchema = z.object({
  value: z.number(),
  fromUnit: z.string().min(1),
  toUnit: z.string().min(1),
})

export const unitCostCalculateSchema = z.object({
  price: z.number().min(0),
  purchaseUnit: z.string().min(1),
  recipeQuantity: z.number().min(0),
  recipeUnit: z.string().min(1),
})

export const validateFamilySchema = z.object({
  unitA: z.string().min(1),
  unitB: z.string().min(1),
})

export const laborConceptSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['fixed', 'per_unit', 'per_batch']),
  timeRequired: z.number().min(0),
  timeUnit: z.enum(['minutes', 'hours', 'seconds']),
  valuePerHour: z.number().min(0),
  operatorName: z.string().max(200).optional(),
  active: z.boolean().optional(),
})

export const upsertLaborCostSchema = z.object({
  concepts: z.array(laborConceptSchema),
})

export const packagingItemSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['optional', 'mandatory', 'by_variant']),
  unit: z.string().min(1),
  quantity: z.number().min(0),
  unitCost: z.number().min(0),
})

export const upsertPackagingCostSchema = z.object({
  items: z.array(packagingItemSchema),
})

export const productionCostItemSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['fixed', 'per_minute', 'per_hour', 'per_batch', 'per_unit']),
  value: z.number().min(0),
  active: z.boolean().optional(),
})

export const upsertProductionCostSchema = z.object({
  items: z.array(productionCostItemSchema),
})

export const serviceCostItemSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['fixed', 'per_unit', 'per_batch']),
  value: z.number().min(0),
  notes: z.string().max(500).optional(),
})

export const upsertServiceCostSchema = z.object({
  items: z.array(serviceCostItemSchema),
})

/** Limpia null → undefined para Zod .optional() */
export function stripNulls<T extends Record<string, unknown>>(raw: T): Partial<T> {
  return Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== null)) as Partial<T>
}

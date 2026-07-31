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

/** Limpia null → undefined para Zod .optional() */
export function stripNulls<T extends Record<string, unknown>>(raw: T): Partial<T> {
  return Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== null)) as Partial<T>
}

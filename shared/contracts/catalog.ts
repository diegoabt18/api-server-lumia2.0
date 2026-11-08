/**
 * Contrato de catálogo: producto y variante tal como los devuelve el servidor hoy.
 * El impuesto se expresa como tarifa numérica (taxRate). La clasificación tributaria
 * ampliada (gravado / 0% / exento / excluido) se añadirá en la fase 3.5.
 */

export interface ProductVariantContract {
  sku: string
  label: string
  barcode: string | null
  /** Precio final con IVA incluido. */
  price: number
  originalPrice: number
  promotionPercentOff?: number
  currency: string
  stock: number
  available: number
  tracked: boolean
  isPerOrder: boolean
}

export interface ProductSummaryContract {
  id: string
  slug: string
  name: string
  imagePath: string | null
  /** Tarifa de IVA en porcentaje. null = no configurada (nunca se asume). */
  taxRate: number | null
  variants: ProductVariantContract[]
}

/** Contrato de carrito y pedido tal como lo devuelve el servidor. */

export interface CartItemContract {
  sku: string
  productSlug: string
  /** Nombre del producto. (Lumia espera `name`; ver fase 3.9.) */
  productName: string
  variantLabel?: string
  quantity: number
  unitPrice: number
  currency: string
  imagePath: string | null
}

export interface CartContract {
  items: CartItemContract[]
  total: number
  subtotal: number
  shippingCost: number
  grandTotal: number
  shippingVariable: boolean
  freeShipping: boolean
  source: 'api'
}

export interface OrderItemContract {
  productId: string
  productSlug?: string
  variantSku?: string
  name: string
  quantity: number
  unitPrice: number
  subtotal: number
  /** Tasa de IVA congelada al vender. null = no configurada en ese momento. */
  taxRate?: number | null
}

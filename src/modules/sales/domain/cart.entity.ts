export interface CartItemEntity {
  sku: string
  productSlug: string
  productName: string
  variantLabel?: string
  quantity: number
  unitPrice: number
  currency: string
  imagePath?: string | null
}

export interface CartEntity {
  cartKey: string
  userId?: string | null
  items: CartItemEntity[]
  updatedAt: Date
}

export interface CartItemDto {
  sku: string
  productSlug: string
  productName: string
  variantLabel?: string
  quantity: number
  unitPrice: number
  currency: string
  imagePath?: string | null
  originalUnitPrice?: number
  promotionPercentOff?: number
  promotionLabel?: string
}

export function cartTotal(items: CartItemDto[]): number {
  return items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0)
}

export function toCartItemDto(item: CartItemEntity): CartItemDto {
  return {
    sku: item.sku,
    productSlug: item.productSlug,
    productName: item.productName,
    variantLabel: item.variantLabel,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    currency: item.currency,
    imagePath: item.imagePath ?? null,
  }
}

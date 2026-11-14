import { AppError } from '../../../common/errors/app.error.js'
import type { ProductRepository } from '../../catalog/infrastructure/product.repository.js'
import type { CartItemEntity } from '../domain/cart.entity.js'
import { cartTotal, toCartItemDto } from '../domain/cart.entity.js'
import type { CartRepository } from '../infrastructure/cart.repository.js'
import type { AddCartItemDto } from '../schemas/cart.schema.js'

export class CartService {
  constructor(
    private readonly carts: CartRepository,
    private readonly products: ProductRepository,
  ) {}

  async getCart(cartKey: string) {
    const cart = await this.carts.findByKey(cartKey)
    const items = (cart?.items ?? []).map(toCartItemDto)
    return {
      items,
      total: cartTotal(items),
      subtotal: cartTotal(items),
      shippingCost: 0,
      grandTotal: cartTotal(items),
      shippingVariable: false,
      freeShipping: false,
      source: 'api' as const,
    }
  }

  async clear(cartKey: string) {
    await this.carts.clear(cartKey)
    return this.getCart(cartKey)
  }

  async addItem(cartKey: string, dto: AddCartItemDto, userId?: string | null) {
    // Precio y producto salen SIEMPRE del catálogo por SKU: lo que envía el navegador es solo para
    // mostrar. Antes el precio se buscaba con el slug enviado y, si no coincidía, quedaba en 0.
    const variant = await this.products.getVariantBySku(dto.sku)
    if (!variant || !(typeof variant.price === 'number' && variant.price > 0)) {
      throw AppError.notFound('Producto no disponible')
    }
    const unitPrice = variant.price
    const cart = await this.carts.findByKey(cartKey)
    const items = [...(cart?.items ?? [])]
    const idx = items.findIndex((i) => i.sku === dto.sku)

    const line: CartItemEntity = {
      sku: dto.sku,
      productSlug: variant.product_slug,
      productName: dto.product?.productName ?? dto.sku,
      variantLabel: dto.product?.variantLabel,
      quantity: dto.quantity,
      unitPrice,
      currency: dto.product?.currency ?? 'COP',
      imagePath: dto.product?.imagePath ?? null,
    }

    if (idx >= 0) items[idx].quantity += dto.quantity
    else items.push(line)

    await this.carts.save(cartKey, items, userId)
    const response = await this.getCart(cartKey)
    return { ok: true, ...response }
  }

  async updateQuantity(cartKey: string, sku: string, quantity: number, userId?: string | null) {
    if (quantity <= 0) return this.removeItem(cartKey, sku, userId)

    const cart = await this.carts.findByKey(cartKey)
    if (!cart) throw AppError.notFound('Cart not found')

    const items = cart.items.map((i) => (i.sku === sku ? { ...i, quantity } : i))
    if (!items.some((i) => i.sku === sku)) throw AppError.notFound('Item not in cart')

    await this.carts.save(cartKey, items, userId)
    return this.getCart(cartKey)
  }

  async removeItem(cartKey: string, sku: string, userId?: string | null) {
    const cart = await this.carts.findByKey(cartKey)
    const items = (cart?.items ?? []).filter((i) => i.sku !== sku)
    await this.carts.save(cartKey, items, userId)
    return this.getCart(cartKey)
  }

  async mergeGuestIntoUser(guestKey: string, userId: string) {
    await this.carts.mergeGuestIntoUser(guestKey, userId)
  }

}

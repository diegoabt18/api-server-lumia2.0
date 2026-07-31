import type { PromotionEntity } from '../catalog/domain/promotion.entity.js'
import {
  applyPercentToPrice,
  resolveBestPromotionForProduct,
  type ResolvedPromotion,
} from '../pricing/promotion-discount.js'
import { promotionEntitiesToUnifiedRules } from '../pricing/promotion-mapper.js'

export type { ResolvedPromotion }
export { applyPercentToPrice }

export function resolveBestPromotionForProductFromEntities(
  productSlug: string,
  categorySlug: string | undefined | null,
  promotions: PromotionEntity[],
  now: Date,
): ResolvedPromotion | null {
  const rules = promotionEntitiesToUnifiedRules(promotions)
  return resolveBestPromotionForProduct(productSlug, categorySlug, rules, now)
}

export function applyPromotionToVariants<T extends { price: number }>(
  variants: T[],
  resolved: ResolvedPromotion | null,
): Array<
  T & {
    originalPrice: number
    salePrice: number
    promotionPercentOff?: number
    promotionEndsAt?: string
    promotionLabel?: string
    promotionId?: string
    promotionDiscountSource?: 'general' | 'individual'
  }
> {
  return variants.map((v) => {
    const originalPrice = v.price
    if (!resolved) {
      return { ...v, originalPrice, salePrice: originalPrice }
    }
    return {
      ...v,
      originalPrice,
      salePrice: applyPercentToPrice(originalPrice, resolved.percentOff),
      promotionPercentOff: resolved.percentOff,
      promotionEndsAt: resolved.endsAt.toISOString(),
      promotionLabel: resolved.promotionName,
      promotionId: resolved.promotionId,
      promotionDiscountSource: resolved.source,
    }
  })
}

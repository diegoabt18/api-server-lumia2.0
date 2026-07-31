export type DiscountSource = 'general' | 'individual'

export type UnifiedPromotionRule = {
  id: string
  name: string
  priority: number
  startsAt: Date
  endsAt: Date
  active: boolean
  applyGeneralDiscount: boolean
  generalPercentOff?: number
  categorySlugs: string[]
  productEntries: Array<{ slug: string; percentOff: number | null }>
  legacyScope?: 'global' | 'products'
  legacyProductPercents?: Record<string, number>
}

export type ResolvedPromotion = {
  percentOff: number
  promotionName: string
  promotionId: string
  endsAt: Date
  source: DiscountSource
}

export function applyPercentToPrice(base: number, percentOff: number): number {
  if (!Number.isFinite(base) || base <= 0) return 0
  const p = clampPct(percentOff)
  return Math.round((base * (100 - p)) / 100)
}

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.min(100, Math.max(0, n))
}

function isPromotionInStoreWindow(r: UnifiedPromotionRule, now: Date): boolean {
  if (!r.active) return false
  return now >= r.startsAt && now <= r.endsAt
}

function inScope(slug: string, categorySlug: string | undefined | null, r: UnifiedPromotionRule): boolean {
  if (r.legacyScope === 'global') return true
  const cat = categorySlug?.trim() || undefined
  if (cat && r.categorySlugs.includes(cat)) return true
  if (r.productEntries.some((e) => e.slug === slug)) return true
  if (r.legacyScope === 'products' && r.legacyProductPercents && slug in r.legacyProductPercents) return true
  return false
}

function resolveEffectiveForRule(
  slug: string,
  categorySlug: string | undefined | null,
  r: UnifiedPromotionRule,
): { percentOff: number; source: DiscountSource } | null {
  if (!inScope(slug, categorySlug, r)) return null

  const entry = r.productEntries.find((e) => e.slug === slug)
  if (entry) {
    if (entry.percentOff != null) {
      const v = clampPct(entry.percentOff)
      if (v <= 0) return null
      return { percentOff: v, source: 'individual' }
    }
    if (r.applyGeneralDiscount && r.generalPercentOff != null) {
      const v = clampPct(r.generalPercentOff)
      if (v <= 0) return null
      return { percentOff: v, source: 'general' }
    }
    return null
  }

  const cat = categorySlug?.trim() || undefined
  if (cat && r.categorySlugs.includes(cat)) {
    if (r.applyGeneralDiscount && r.generalPercentOff != null) {
      const v = clampPct(r.generalPercentOff)
      if (v <= 0) return null
      return { percentOff: v, source: 'general' }
    }
    return null
  }

  if (r.legacyScope === 'products' && r.legacyProductPercents?.[slug] != null) {
    const v = clampPct(r.legacyProductPercents[slug])
    if (v <= 0) return null
    return { percentOff: v, source: 'individual' }
  }

  if (r.legacyScope === 'global' && r.applyGeneralDiscount && r.generalPercentOff != null) {
    const v = clampPct(r.generalPercentOff)
    if (v <= 0) return null
    return { percentOff: v, source: 'general' }
  }

  return null
}

export function resolveBestPromotionForProduct(
  productSlug: string,
  categorySlug: string | undefined | null,
  rules: UnifiedPromotionRule[],
  now: Date,
): ResolvedPromotion | null {
  let best: ResolvedPromotion | null = null
  let bestPriority = 0
  for (const r of rules) {
    if (!isPromotionInStoreWindow(r, now)) continue
    const eff = resolveEffectiveForRule(productSlug, categorySlug, r)
    if (!eff) continue
    const cand: ResolvedPromotion = {
      percentOff: eff.percentOff,
      promotionName: r.name,
      promotionId: r.id,
      endsAt: r.endsAt,
      source: eff.source,
    }
    if (!best) {
      best = cand
      bestPriority = r.priority
      continue
    }
    if (cand.percentOff > best.percentOff) {
      best = cand
      bestPriority = r.priority
    } else if (cand.percentOff === best.percentOff && r.priority < bestPriority) {
      best = cand
      bestPriority = r.priority
    }
  }
  return best
}

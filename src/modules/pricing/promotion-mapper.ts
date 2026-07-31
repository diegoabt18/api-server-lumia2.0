import type { PromotionEntity } from '../catalog/domain/promotion.entity.js'
import type { UnifiedPromotionRule } from '../pricing/promotion-discount.js'

function dedupeProductEntries(
  entries: Array<{ slug: string; percentOff: number | null }>,
): Array<{ slug: string; percentOff: number | null }> {
  const m = new Map<string, { slug: string; percentOff: number | null }>()
  for (const e of entries) m.set(e.slug, e)
  return [...m.values()]
}

function coerceDate(d: Date | string | undefined): Date {
  if (d instanceof Date) return d
  const x = new Date(String(d ?? ''))
  return Number.isNaN(x.getTime()) ? new Date() : x
}

export function promotionEntityToUnified(e: PromotionEntity): UnifiedPromotionRule {
  const id = e._id ? String(e._id) : ''
  const genPctRaw =
    typeof e.general_percent_off === 'number'
      ? e.general_percent_off
      : typeof e.global_percent_off === 'number'
        ? e.global_percent_off
        : undefined
  const legacyScope = e.scope
  const applyGeneralDiscount = legacyScope === 'global' ? true : e.apply_general_discount === true

  let productEntries: Array<{ slug: string; percentOff: number | null }> = []
  if (Array.isArray(e.product_entries) && e.product_entries.length) {
    productEntries = e.product_entries.map((x) => ({
      slug: x.product_slug.trim(),
      percentOff: x.percent_off,
    }))
  } else if (legacyScope === 'products' && e.product_percents && Object.keys(e.product_percents).length) {
    productEntries = Object.entries(e.product_percents).map(([slug, pct]) => ({
      slug,
      percentOff: pct,
    }))
  }

  return {
    id,
    name: e.name,
    priority: typeof e.priority === 'number' ? e.priority : 100,
    startsAt: coerceDate(e.starts_at),
    endsAt: coerceDate(e.ends_at),
    active: e.active !== false,
    applyGeneralDiscount,
    generalPercentOff: genPctRaw,
    categorySlugs: Array.isArray(e.category_slugs)
      ? [...new Set(e.category_slugs.map((s) => s.trim()).filter(Boolean))]
      : [],
    productEntries: dedupeProductEntries(productEntries),
    legacyScope,
    legacyProductPercents: e.product_percents,
  }
}

export function promotionEntitiesToUnifiedRules(entities: PromotionEntity[]): UnifiedPromotionRule[] {
  return entities.map(promotionEntityToUnified)
}

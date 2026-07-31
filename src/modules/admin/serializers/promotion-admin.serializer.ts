import {
  computePromotionLifecycle,
  type PromotionEntity,
} from '../../catalog/domain/promotion.entity.js'

function coerceDate(d: unknown): Date {
  if (d instanceof Date) return d
  const x = new Date(String(d ?? ''))
  return Number.isNaN(x.getTime()) ? new Date() : x
}

export function serializePromotionAdmin(e: PromotionEntity, now: Date) {
  const startsAt = coerceDate(e.starts_at)
  const endsAt = coerceDate(e.ends_at)
  const active = e.active !== false
  const gen =
    typeof e.general_percent_off === 'number'
      ? e.general_percent_off
      : typeof e.global_percent_off === 'number'
        ? e.global_percent_off
        : null

  return {
    id: String(e._id),
    name: e.name,
    description: typeof e.description === 'string' ? e.description : '',
    bannerUrl: e.banner_url ?? null,
    active,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    lifecycle: computePromotionLifecycle(startsAt, endsAt, active, now),
    priority: typeof e.priority === 'number' ? e.priority : 100,
    applyGeneralDiscount: e.scope === 'global' ? true : e.apply_general_discount === true,
    generalPercentOff: gen,
    categorySlugs: [...new Set((e.category_slugs ?? []).map((s) => s.trim()).filter(Boolean))],
    productEntries: (e.product_entries ?? []).map((x) => ({
      productSlug: x.product_slug,
      percentOff: x.percent_off,
    })),
    notificationImageSlug: e.notification_image_slug?.trim() || null,
    notificationImagePath: e.notification_image_path?.trim() || null,
    legacyScope: e.scope,
    createdAt: e.created_at instanceof Date ? e.created_at.toISOString() : null,
    updatedAt: e.updated_at instanceof Date ? e.updated_at.toISOString() : null,
  }
}

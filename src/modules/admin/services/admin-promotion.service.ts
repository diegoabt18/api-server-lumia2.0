import { AppError } from '../../../common/errors/app.error.js'
import { buildPaginationMeta, resolvePagingQuery } from '../../../common/utils/pagination.js'
import type { PromotionRepository } from '../../catalog/infrastructure/promotion.repository.js'
import type { PromotionEntity } from '../../catalog/domain/promotion.entity.js'
import { serializePromotionAdmin } from '../serializers/promotion-admin.serializer.js'
import type { PromotionUpsertInput } from '../schemas/admin.schema.js'

function dedupeEntries(entries: Array<{ product_slug: string; percent_off: number | null }>) {
  const m = new Map<string, { product_slug: string; percent_off: number | null }>()
  for (const e of entries) {
    const slug = e.product_slug.trim()
    if (!slug) continue
    m.set(slug, { product_slug: slug, percent_off: e.percent_off })
  }
  return [...m.values()]
}

function validatePromotionBusinessRules(data: PromotionUpsertInput): { ok: true } | { ok: false; message: string } {
  const categories = [...new Set((data.category_slugs ?? []).map((s) => s.trim()).filter(Boolean))]
  const entries = dedupeEntries(data.product_entries ?? [])
  if (categories.length === 0 && entries.length === 0) {
    return { ok: false, message: 'Debes incluir al menos una categoría o un producto' }
  }
  if (data.apply_general_discount) {
    if (data.general_percent_off == null) {
      return { ok: false, message: 'Con descuento general activo, indica el porcentaje' }
    }
  } else {
    if (categories.length > 0) {
      return {
        ok: false,
        message: 'Las promociones por categoría requieren activar el descuento general',
      }
    }
    if (!entries.length || entries.some((e) => e.percent_off === null)) {
      return { ok: false, message: 'Sin descuento general, cada producto debe tener un porcentaje individual' }
    }
  }
  return { ok: true }
}

function buildEntityFromUpsert(data: PromotionUpsertInput, now: Date, existing?: PromotionEntity | null) {
  const categories = [...new Set((data.category_slugs ?? []).map((s) => s.trim()).filter(Boolean))]
  const entries = dedupeEntries(data.product_entries ?? [])
  const doc: Omit<PromotionEntity, '_id'> = {
    name: data.name.trim(),
    description: data.description?.trim() || undefined,
    banner_url: data.banner_url?.trim() || undefined,
    active: data.active ?? true,
    starts_at: new Date(data.starts_at),
    ends_at: new Date(data.ends_at),
    priority: data.priority ?? 100,
    apply_general_discount: data.apply_general_discount,
    category_slugs: categories,
    product_entries: entries.map((e) => ({ product_slug: e.product_slug, percent_off: e.percent_off })),
    created_at: existing?.created_at ?? now,
    updated_at: now,
  }
  if (data.apply_general_discount && data.general_percent_off != null) {
    doc.general_percent_off = data.general_percent_off
  }
  if (data.notification_image_slug?.trim()) doc.notification_image_slug = data.notification_image_slug.trim()
  if (data.notification_image_path?.trim()) doc.notification_image_path = data.notification_image_path.trim()
  return doc
}

export class AdminPromotionService {
  constructor(private readonly promotions: PromotionRepository) {}

  async list(query: Record<string, unknown>) {
    const { page, limit, skip, search } = resolvePagingQuery(query, { defaultLimit: 20, maxLimit: 100 })
    const lifecycle = typeof query.lifecycle === 'string' ? query.lifecycle : undefined
    const activeRaw = typeof query.activeOnly === 'string' ? query.activeOnly : undefined
    const activeOnly = activeRaw === '1' || activeRaw === 'true'
    const now = new Date()
    const filters = {
      search: search || undefined,
      lifecycle: lifecycle === 'all' ? undefined : (lifecycle as 'pendiente' | 'activa' | 'finalizada' | undefined),
      activeOnly: activeOnly || undefined,
    }
    const [total, raw] = await Promise.all([
      this.promotions.countAdmin(filters, now),
      this.promotions.listAdmin(skip, limit, filters, now),
    ])
    const promotions = raw.map((e) => serializePromotionAdmin(e, now))
    return { promotions, pagination: buildPaginationMeta(total, page, limit) }
  }

  async get(id: string) {
    const entity = await this.promotions.findByIdSafe(id)
    if (!entity) throw AppError.notFound('Promoción no encontrada')
    return { promotion: serializePromotionAdmin(entity, new Date()) }
  }

  async create(data: PromotionUpsertInput) {
    const rules = validatePromotionBusinessRules(data)
    if (!rules.ok) throw AppError.badRequest(rules.message)
    const now = new Date()
    const doc = buildEntityFromUpsert(data, now)
    const id = await this.promotions.insertOne(doc as never)
    return { id }
  }

  async update(id: string, data: PromotionUpsertInput) {
    const existing = await this.promotions.findByIdSafe(id)
    if (!existing) throw AppError.notFound('Promoción no encontrada')
    const rules = validatePromotionBusinessRules(data)
    if (!rules.ok) throw AppError.badRequest(rules.message)
    const now = new Date()
    const doc = buildEntityFromUpsert(data, now, existing)
    const ok = await this.promotions.replaceById(id, doc)
    if (!ok) throw AppError.notFound('Promoción no encontrada')
    return { ok: true }
  }

  async delete(id: string) {
    const ok = await this.promotions.deleteById(id)
    if (!ok) throw AppError.notFound('Promoción no encontrada')
    return { ok: true }
  }

  async setActive(id: string, active: boolean) {
    const ok = await this.promotions.patchActive(id, active)
    if (!ok) throw AppError.notFound('Promoción no encontrada')
    return { ok: true, active }
  }
}

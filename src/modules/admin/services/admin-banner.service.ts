import { AppError } from '../../../common/errors/app.error.js'
import type { StoreBannerRepository } from '../../catalog/infrastructure/store-banner.repository.js'
import type { StoreBannerEntity } from '../../catalog/domain/store-banner.entity.js'
import type { StoreBannerUpsertInput } from '../schemas/admin.schema.js'

function buildBannerFromUpsert(
  data: StoreBannerUpsertInput,
  now: Date,
  existing?: StoreBannerEntity | null,
): Omit<StoreBannerEntity, '_id'> {
  return {
    active: data.active ?? true,
    position: data.position,
    priority: data.priority ?? 100,
    starts_at: new Date(data.starts_at),
    ends_at: new Date(data.ends_at),
    image_url: data.image_url.trim(),
    title: data.title?.trim() || undefined,
    subtitle: data.subtitle?.trim() || undefined,
    cta_label: data.cta_label?.trim() || undefined,
    cta_href: data.cta_href?.trim() || undefined,
    promotion_id: data.promotion_id?.trim() || undefined,
    category_slug: data.category_slug?.trim() || undefined,
    collection_slug: data.collection_slug?.trim() || undefined,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  }
}

export class AdminBannerService {
  constructor(private readonly banners: StoreBannerRepository) {}

  async list() {
    const rows = await this.banners.listAll()
    return { banners: rows.map((e) => this.banners.adminSerialize(e)) }
  }

  async get(id: string) {
    const row = await this.banners.findByIdSafe(id)
    if (!row) throw AppError.notFound('Banner no encontrado')
    return { banner: this.banners.adminSerialize(row) }
  }

  async create(data: StoreBannerUpsertInput) {
    const now = new Date()
    const doc = buildBannerFromUpsert(data, now)
    const id = await this.banners.insertBanner(doc)
    return { id }
  }

  async update(id: string, data: StoreBannerUpsertInput) {
    const existing = await this.banners.findByIdSafe(id)
    if (!existing) throw AppError.notFound('Banner no encontrado')
    const now = new Date()
    const doc = buildBannerFromUpsert(data, now, existing)
    const ok = await this.banners.replaceById(id, doc)
    if (!ok) throw AppError.notFound('Banner no encontrado')
    return { ok: true }
  }

  async delete(id: string) {
    const ok = await this.banners.deleteById(id)
    if (!ok) throw AppError.notFound('Banner no encontrado')
    return { ok: true }
  }
}

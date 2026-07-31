import type { StoreBannerRepository } from '../../catalog/infrastructure/store-banner.repository.js'
import {
  isStoreBannerPosition,
  type StoreBannerPosition,
} from '../../catalog/domain/store-banner.entity.js'
import type { StoreSettingsRepository } from '../infrastructure/store-settings.repository.js'

export class StoreService {
  constructor(
    private readonly settings: StoreSettingsRepository,
    private readonly banners: StoreBannerRepository,
  ) {}

  async getBanners(positionsRaw?: string) {
    const positions: StoreBannerPosition[] | undefined = positionsRaw
      ? positionsRaw
          .split(',')
          .map((s) => s.trim())
          .filter((s): s is StoreBannerPosition => isStoreBannerPosition(s))
      : undefined
    const rows = await this.banners.findPublicVisible(new Date(), positions?.length ? positions : undefined)
    return { banners: rows.map((r) => this.banners.toPublicDto(r)) }
  }

  async getShippingSettings() {
    const data = await this.settings.getShippingSettings()
    return { data }
  }

  async getCurrencySettings() {
    const data = await this.settings.getCurrencySettings()
    return { data }
  }

  async getCustomerSettings() {
    const s = await this.settings.getCustomerFrontSettings()
    return {
      settings: {
        supportWhatsappPhone: s.supportWhatsappPhone,
        contactEmail: s.contactEmail,
        faqItems: s.faqItems ?? [],
        policiesContent: s.policiesContent ?? '',
        policiesUrl: s.policiesUrl ?? '',
        termsContent: s.termsContent ?? '',
        termsUrl: s.termsUrl ?? '',
        updatedAt: s.updatedAt instanceof Date ? s.updatedAt.toISOString() : undefined,
      },
    }
  }
}

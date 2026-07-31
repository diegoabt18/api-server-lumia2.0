import type { StoreSettingsRepository } from '../../store/infrastructure/store-settings.repository.js'
import type { ShippingConfig } from '../../../common/config/shipping-config.js'
import type { CurrencyConfig } from '../../../common/config/currency-config.js'
import type { StoreCustomerFrontSettings } from '../../store/infrastructure/store-settings.repository.js'
import {
  AVAILABLE_PAYMENT_METHODS,
  type PaymentMethod,
} from '../../payments/domain/payment-method.js'

export class AdminStoreService {
  constructor(private readonly settings: StoreSettingsRepository) {}

  getShippingSettings() {
    return this.settings.getShippingSettings().then((data) => ({ data }))
  }

  putShippingSettings(config: ShippingConfig) {
    return this.settings.upsertShippingSettings(config).then((data) => ({ data }))
  }

  getCurrencySettings() {
    return this.settings.getCurrencySettings().then((data) => ({ data }))
  }

  patchCurrencySettings(config: Partial<CurrencyConfig>) {
    return this.settings.getCurrencySettings().then(async (current) => {
      const merged = { ...current, ...config }
      const data = await this.settings.upsertCurrencySettings(merged)
      return { data }
    })
  }

  getCustomerSettings() {
    return this.settings.getCustomerFrontSettings().then((settings) => ({ settings }))
  }

  patchCustomerSettings(patch: Partial<StoreCustomerFrontSettings>) {
    return this.settings.upsertCustomerFrontSettings(patch).then((settings) => ({ settings }))
  }

  async getPaymentSettings() {
    const settings = await this.settings.getPaymentSettings()
    const methodsWithMeta = settings.methods.map((m) => {
      const meta = AVAILABLE_PAYMENT_METHODS.find((pm) => pm.id === (m.methodId as PaymentMethod))
      return {
        methodId: m.methodId,
        isActive: m.isActive,
        displayName: meta?.displayName ?? m.methodId,
        description: meta?.description ?? '',
        icon: meta?.icon ?? null,
        requiresRedirect: meta?.requiresRedirect ?? false,
        estimatedProcessingTime: meta?.estimatedProcessingTime ?? '',
      }
    })
    return { methods: methodsWithMeta, updatedAt: settings.updatedAt?.toISOString() ?? null }
  }

  async patchPaymentSettings(methods: Array<{ methodId: PaymentMethod; isActive: boolean }>) {
    await this.settings.upsertPaymentSettings(methods)
    return this.getPaymentSettings()
  }

  resetShippingSettings() {
    return this.settings.resetShippingSettings().then((data) => ({ data }))
  }
}

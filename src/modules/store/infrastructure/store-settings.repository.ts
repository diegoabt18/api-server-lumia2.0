import type { Db } from 'mongodb'
import { getCollection } from '../../../database/repositories/base.repository.js'
import {
  DEFAULT_CURRENCY_CONFIG,
  type CurrencyConfig,
} from '../../../common/config/currency-config.js'
import {
  DEFAULT_SHIPPING_CONFIG,
  type ShippingConfig,
} from '../../../common/config/shipping-config.js'

const SHIPPING_COL = 'store_shipping_settings'
const CURRENCY_COL = 'store_currency_settings'
const CUSTOMER_COL = 'store_customer_front_settings'
const PAYMENT_COL = 'store_payment_settings'
const DOC_ID = 'default'

export type PaymentMethodState = { methodId: string; isActive: boolean }

export type StorePaymentSettings = {
  methods: PaymentMethodState[]
  updatedAt?: Date
}

export type StoreFaqItem = { id: string; question: string; answer: string }

export type StoreCustomerFrontSettings = {
  supportWhatsappPhone: string
  contactEmail: string
  faqItems: StoreFaqItem[]
  policiesContent: string
  policiesUrl: string
  termsContent: string
  termsUrl: string
  updatedAt?: Date
}

function defaultPaymentMethodStates(): PaymentMethodState[] {
  return [
    { methodId: 'mercadopago', isActive: true },
    { methodId: 'manual', isActive: true },
  ]
}

function defaultCustomerSettings(): StoreCustomerFrontSettings {
  return {
    supportWhatsappPhone: '',
    contactEmail: '',
    faqItems: [],
    policiesContent: '',
    policiesUrl: '',
    termsContent: '',
    termsUrl: '',
  }
}

export class StoreSettingsRepository {
  constructor(private readonly db: Db) {}

  async getShippingSettings(): Promise<ShippingConfig> {
    const doc = await getCollection<{ config: ShippingConfig }>(this.db, SHIPPING_COL).findOne({
      _id: DOC_ID,
    } as never)
    if (!doc?.config) return this.upsertShippingSettings(DEFAULT_SHIPPING_CONFIG)
    return {
      ...DEFAULT_SHIPPING_CONFIG,
      ...doc.config,
      messages: { ...DEFAULT_SHIPPING_CONFIG.messages, ...doc.config.messages },
    }
  }

  async upsertShippingSettings(config: ShippingConfig): Promise<ShippingConfig> {
    await getCollection(this.db, SHIPPING_COL).updateOne(
      { _id: DOC_ID } as never,
      { $set: { config, updatedAt: new Date() }, $setOnInsert: { _id: DOC_ID } },
      { upsert: true },
    )
    return {
      ...DEFAULT_SHIPPING_CONFIG,
      ...config,
      messages: { ...DEFAULT_SHIPPING_CONFIG.messages, ...config.messages },
    }
  }

  async getCurrencySettings(): Promise<CurrencyConfig> {
    const doc = await getCollection<{ config: CurrencyConfig }>(this.db, CURRENCY_COL).findOne({
      _id: DOC_ID,
    } as never)
    if (!doc?.config) return this.upsertCurrencySettings(DEFAULT_CURRENCY_CONFIG)
    return { ...DEFAULT_CURRENCY_CONFIG, ...doc.config }
  }

  async upsertCurrencySettings(config: CurrencyConfig): Promise<CurrencyConfig> {
    await getCollection(this.db, CURRENCY_COL).updateOne(
      { _id: DOC_ID } as never,
      { $set: { config, updatedAt: new Date() }, $setOnInsert: { _id: DOC_ID } },
      { upsert: true },
    )
    return { ...DEFAULT_CURRENCY_CONFIG, ...config }
  }

  async getCustomerFrontSettings(): Promise<StoreCustomerFrontSettings> {
    const doc = await getCollection<StoreCustomerFrontSettings & { _id: string }>(this.db, CUSTOMER_COL).findOne({
      _id: DOC_ID,
    } as never)
    if (!doc) return defaultCustomerSettings()
    return { ...defaultCustomerSettings(), ...doc }
  }

  async upsertCustomerFrontSettings(
    patch: Partial<StoreCustomerFrontSettings>,
  ): Promise<StoreCustomerFrontSettings> {
    await getCollection(this.db, CUSTOMER_COL).updateOne(
      { _id: DOC_ID } as never,
      { $set: { ...patch, updatedAt: new Date() }, $setOnInsert: { _id: DOC_ID } },
      { upsert: true },
    )
    return this.getCustomerFrontSettings()
  }

  async getPaymentSettings(): Promise<StorePaymentSettings> {
    const doc = await getCollection<StorePaymentSettings & { _id: string }>(this.db, PAYMENT_COL).findOne({
      _id: DOC_ID,
    } as never)
    if (!doc) return { methods: defaultPaymentMethodStates() }
    return { methods: doc.methods ?? defaultPaymentMethodStates(), updatedAt: doc.updatedAt }
  }

  async upsertPaymentSettings(methods: PaymentMethodState[]): Promise<StorePaymentSettings> {
    const now = new Date()
    await getCollection(this.db, PAYMENT_COL).updateOne(
      { _id: DOC_ID } as never,
      { $set: { methods, updatedAt: now }, $setOnInsert: { _id: DOC_ID } },
      { upsert: true },
    )
    return this.getPaymentSettings()
  }

  async resetShippingSettings(): Promise<ShippingConfig> {
    return this.upsertShippingSettings(DEFAULT_SHIPPING_CONFIG)
  }
}

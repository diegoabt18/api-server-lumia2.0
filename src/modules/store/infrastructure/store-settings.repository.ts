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

/**
 * Payment method state stored in `store_payment_settings.methods`. Display metadata is optional:
 * when absent, the presentation layer falls back to the code defaults in payment-method.ts.
 */
export type PaymentMethodState = {
  methodId: string
  isActive: boolean
  displayName?: string
  description?: string
  estimatedProcessingTime?: string
}

/** Bank account details shown when collecting a bank_transfer payment (e.g. POS). */
export type BankTransferDetails = {
  bankName: string
  accountNumber: string
  accountHolder: string
  taxId?: string
  instructions?: string
}

export type StorePaymentSettings = {
  methods: PaymentMethodState[]
  bankTransferDetails?: BankTransferDetails | null
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
  /** Espera antes de mostrar el tooltip de una promoción en la tienda (ms). */
  promotionTooltipDelayMs?: number
  updatedAt?: Date
}

export const DEFAULT_PROMOTION_TOOLTIP_DELAY_MS = 1000

function defaultPaymentMethodStates(): PaymentMethodState[] {
  return [
    { methodId: 'mercadopago', isActive: true },
    { methodId: 'manual', isActive: true },
    { methodId: 'cash', isActive: true },
    { methodId: 'bank_transfer', isActive: true },
  ]
}

/**
 * Stored settings may predate newer methods (e.g. cash / bank_transfer). A method with no stored
 * entry falls back to its default state instead of being treated as disabled.
 * Stored entries always win, so explicit deactivations are respected.
 */
function withDefaultPaymentMethods(stored: PaymentMethodState[] | undefined): PaymentMethodState[] {
  const known = new Set((stored ?? []).map((method) => method.methodId))
  const missing = defaultPaymentMethodStates().filter((method) => !known.has(method.methodId))
  return [...(stored ?? []), ...missing]
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
    promotionTooltipDelayMs: DEFAULT_PROMOTION_TOOLTIP_DELAY_MS,
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
    if (!doc) return { methods: defaultPaymentMethodStates(), bankTransferDetails: null }
    return {
      methods: withDefaultPaymentMethods(doc.methods),
      bankTransferDetails: doc.bankTransferDetails ?? null,
      updatedAt: doc.updatedAt,
    }
  }

  async upsertPaymentSettings(
    methods: PaymentMethodState[],
    bankTransferDetails?: BankTransferDetails | null,
  ): Promise<StorePaymentSettings> {
    const now = new Date()
    // Persist every known method so a missing entry can never be read as "disabled".
    const $set: Record<string, unknown> = { methods: withDefaultPaymentMethods(methods), updatedAt: now }
    if (bankTransferDetails !== undefined) {
      $set.bankTransferDetails = bankTransferDetails
    }
    await getCollection(this.db, PAYMENT_COL).updateOne(
      { _id: DOC_ID } as never,
      { $set, $setOnInsert: { _id: DOC_ID } },
      { upsert: true },
    )
    return this.getPaymentSettings()
  }

  async resetShippingSettings(): Promise<ShippingConfig> {
    return this.upsertShippingSettings(DEFAULT_SHIPPING_CONFIG)
  }
}

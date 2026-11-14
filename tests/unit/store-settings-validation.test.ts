import { describe, expect, it } from 'vitest'
import {
  currencySettingsPatchSchema,
  customerSettingsPatchSchema,
  safeLinkHref,
  shippingSettingsBodySchema,
} from '../../src/modules/admin/schemas/store-settings.schema.js'
import { storeBannerUpsertSchema } from '../../src/modules/admin/schemas/admin.schema.js'

const shipping = {
  shippingEnabled: true,
  freeShippingEnabled: true,
  freeShippingThreshold: 150000,
  flatRateEnabled: true,
  flatRate: 12000,
  applyThresholdOn: 'subtotal',
  showProgressBar: true,
  showMessages: true,
  messages: { remainingMessage: 'Faltan {remaining}' },
}

describe('store settings validation', () => {
  it('accepts a valid shipping body and forces flat_rate', () => {
    const parsed = shippingSettingsBodySchema.parse(shipping)
    expect(parsed.calculationType).toBe('flat_rate')
  })

  it('drops unknown keys instead of storing them', () => {
    const parsed = shippingSettingsBodySchema.parse({ ...shipping, $where: 'x', injected: true })
    expect(parsed).not.toHaveProperty('injected')
    expect(parsed).not.toHaveProperty('$where')
  })

  it('rejects wrong types and negative amounts', () => {
    expect(shippingSettingsBodySchema.safeParse({ ...shipping, flatRate: -1 }).success).toBe(false)
    expect(shippingSettingsBodySchema.safeParse({ ...shipping, flatRate: '12000' }).success).toBe(
      false,
    )
    expect(
      shippingSettingsBodySchema.safeParse({ ...shipping, calculationType: 'per_kg' }).success,
    ).toBe(false)
  })

  it('validates currency patches', () => {
    expect(currencySettingsPatchSchema.safeParse({ decimalPlaces: 2 }).success).toBe(true)
    expect(currencySettingsPatchSchema.safeParse({ decimalPlaces: 99 }).success).toBe(false)
    expect(currencySettingsPatchSchema.safeParse({ code: 'pesos' }).success).toBe(false)
  })

  it('rejects dangerous customer links', () => {
    expect(customerSettingsPatchSchema.safeParse({ policiesUrl: '/politicas' }).success).toBe(true)
    expect(customerSettingsPatchSchema.safeParse({ policiesUrl: '' }).success).toBe(true)
    expect(
      customerSettingsPatchSchema.safeParse({ policiesUrl: 'javascript:alert(1)' }).success,
    ).toBe(false)
    expect(customerSettingsPatchSchema.safeParse({ termsUrl: '//evil.example' }).success).toBe(
      false,
    )
  })
})

describe('safeLinkHref', () => {
  it.each(['/products?category=velas', 'https://cdn.example.com/a.avif'])('accepts %s', (v) => {
    expect(safeLinkHref.safeParse(v).success).toBe(true)
  })
  it.each([
    'javascript:alert(1)',
    'data:text/html,hi',
    '//evil.example',
    '/\\evil.example',
    'http://insecure.example',
    'https://user:pass@example.com',
  ])('rejects %s', (v) => {
    expect(safeLinkHref.safeParse(v).success).toBe(false)
  })
})

describe('store banner links', () => {
  const banner = {
    position: 'homepage_hero',
    starts_at: '2026-01-01T00:00:00.000Z',
    ends_at: '2026-12-31T00:00:00.000Z',
    image_url: 'https://cdn.example.com/banner.avif',
  }
  it('accepts internal and https links', () => {
    expect(storeBannerUpsertSchema.safeParse({ ...banner, cta_href: '/products' }).success).toBe(true)
  })
  it('rejects javascript: call-to-action links', () => {
    const result = storeBannerUpsertSchema.safeParse({ ...banner, cta_href: 'javascript:alert(1)' })
    expect(result.success).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { AppError } from '../../src/common/errors/app.error.js'
import {
  buildAssistRequest,
  lumiProductAssistSchema,
  sanitizeSuggestion,
  type ProductAssistSource,
} from '../../src/modules/lumi/services/lumi-product-assist.js'

const source: ProductAssistSource = {
  product: {
    name: 'Vela de soja',
    categorySlug: 'velas',
    brand: null,
    description: 'Vela artesanal de lavanda.',
  },
}

describe('lumiProductAssistSchema', () => {
  it('accepts known actions and tones, rejects anything else', () => {
    expect(lumiProductAssistSchema.safeParse({ action: 'generate_title' }).success).toBe(true)
    expect(
      lumiProductAssistSchema.safeParse({ action: 'change_tone', tone: 'formal' }).success,
    ).toBe(true)
    expect(lumiProductAssistSchema.safeParse({ action: 'publish_now' }).success).toBe(false)
    expect(
      lumiProductAssistSchema.safeParse({ action: 'change_tone', tone: 'agresivo' }).success,
    ).toBe(false)
  })
})

describe('buildAssistRequest', () => {
  it('keeps instructions fixed and forbids invented facts', () => {
    const plan = buildAssistRequest({ action: 'generate_description' }, source)
    expect(plan.instructions).toContain('No inventes')
    expect(plan.instructions).toContain('2 o 3 párrafos')
    expect(plan.input).toContain('Producto: Vela de soja')
    expect(plan.input).toContain('Vela artesanal de lavanda.')
  })

  it('uses the tone chosen by the admin, never free text from the browser', () => {
    const plan = buildAssistRequest(
      { action: 'change_tone', tone: 'friendly', text: 'Texto' },
      source,
    )
    expect(plan.instructions).toContain('cercano y amable')
    expect(plan.input).toContain('Texto de trabajo:\nTexto')
  })

  it('requires text for corrections and improvements', () => {
    const empty = { product: { ...source.product, description: null } }
    expect(() => buildAssistRequest({ action: 'fix_spelling' }, empty)).toThrow(AppError)
    expect(() => buildAssistRequest({ action: 'improve_description', text: '   ' }, empty)).toThrow(
      AppError,
    )
  })

  it('bounds the output size per action', () => {
    expect(buildAssistRequest({ action: 'generate_title' }, source).maxTokens).toBeLessThan(
      buildAssistRequest({ action: 'generate_description' }, source).maxTokens,
    )
  })
})

describe('sanitizeSuggestion', () => {
  it('removes quotes, markdown and code fences', () => {
    expect(sanitizeSuggestion('generate_description', '```\n**Vela** de soja\n```')).toBe(
      'Vela de soja',
    )
    expect(sanitizeSuggestion('generate_title', '"Vela de soja artesanal"')).toBe(
      'Vela de soja artesanal',
    )
  })

  it('keeps single-line outputs on one line and within limits', () => {
    expect(sanitizeSuggestion('seo_title', 'Vela\nde soja   artesanal')).toBe(
      'Vela de soja artesanal',
    )
    expect(sanitizeSuggestion('seo_title', 'x'.repeat(200)).length).toBeLessThanOrEqual(60)
    expect(sanitizeSuggestion('meta_description', 'y'.repeat(400)).length).toBeLessThanOrEqual(160)
  })

  it('refuses empty suggestions', () => {
    expect(() => sanitizeSuggestion('generate_title', '  ""  ')).toThrow(AppError)
  })
})

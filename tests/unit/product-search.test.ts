import { describe, expect, it } from 'vitest'
import {
  PRODUCT_SEARCH_FIELDS,
  SEARCH_MAX_CHARS,
  SEARCH_MAX_WORDS,
  accentInsensitivePattern,
  productTextFilter,
  searchWords,
} from '../../src/modules/catalog/domain/product-search.js'

const matches = (pattern: string, value: string) => new RegExp(pattern, 'i').test(value)

describe('búsqueda común de productos', () => {
  it('no distingue tildes ni mayúsculas, y la ñ', () => {
    expect(matches(accentInsensitivePattern('ambar'), 'Vela Vainilla Ámbar')).toBe(true)
    expect(matches(accentInsensitivePattern('ÁMBAR'), 'ambar')).toBe(true)
    expect(matches(accentInsensitivePattern('pina'), 'Piña colada')).toBe(true)
  })

  it('escapa el texto del usuario: nunca es una expresión regular', () => {
    expect(matches(accentInsensitivePattern('.*'), 'cualquier cosa')).toBe(false)
    expect(matches(accentInsensitivePattern('(cítrico)'), 'Difusor (Cítrico)')).toBe(true)
    expect(() => new RegExp(accentInsensitivePattern('[a-z+'))).not.toThrow()
  })

  it('contains: una cláusula por palabra significativa, en cualquier orden', () => {
    const filter = productTextFilter('vela de ambar', PRODUCT_SEARCH_FIELDS.assistant) as { $and: unknown[] }
    expect(filter.$and).toHaveLength(2)
    expect(searchWords('vela de ambar')).toEqual(['vela', 'ambar'])
  })

  it('una búsqueda de solo palabras vacías no se convierte en "todo el catálogo"', () => {
    expect(searchWords('de la')).toEqual(['de', 'la'])
  })

  it('exact: el campo entero, con los mismos campos', () => {
    const filter = productTextFilter('Lumi Vela', ['name', 'slug'], 'exact') as { $or: Array<Record<string, { $regex: string }>> }
    expect(filter.$or).toHaveLength(2)
    const pattern = filter.$or[0]!.name!.$regex
    expect(matches(pattern, 'lumi vela')).toBe(true)
    expect(matches(pattern, 'Lumi Vela Grande')).toBe(false)
  })

  it('sin texto devuelve null y el texto se acota', () => {
    expect(productTextFilter('   ', PRODUCT_SEARCH_FIELDS.admin)).toBeNull()
    expect(searchWords('a b c d e f g h i')).toHaveLength(SEARCH_MAX_WORDS)
    expect(searchWords('x'.repeat(500))[0]!.length).toBe(SEARCH_MAX_CHARS)
  })

  it('cada superficie conserva sus campos de siempre', () => {
    expect(PRODUCT_SEARCH_FIELDS.storefront).toEqual(['name', 'slug', 'description', 'brand'])
    expect(PRODUCT_SEARCH_FIELDS.admin).toEqual(['name', 'slug', 'description'])
    expect(PRODUCT_SEARCH_FIELDS.posProduct).toEqual(['name', 'slug', 'brand'])
    expect(PRODUCT_SEARCH_FIELDS.posVariant).toEqual(['sku', 'barcode', 'description'])
  })
})

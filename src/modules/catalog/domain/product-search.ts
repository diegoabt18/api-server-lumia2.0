/**
 * Búsqueda de productos ÚNICA del Server. Antes había cuatro implementaciones con reglas distintas
 * (tienda, panel, POS y Lumi); todas construyen ahora su filtro aquí.
 *
 * Modos:
 *  - `contains` (por defecto): cada palabra debe aparecer en alguno de los campos, en cualquier
 *    orden. "vela ambar" encuentra "Vela Vainilla Ámbar".
 *  - `exact`: el texto completo coincide con el campo entero ("lumi vela" = "Lumi Vela").
 * En ambos modos no se distinguen mayúsculas ni tildes, y el texto del usuario se escapa: nunca se
 * interpreta como expresión regular.
 *
 * Sin relevancia ni búsqueda semántica: no hay índice de texto ni embeddings (decisión de la
 * auditoría de viabilidad; requieren aprobación).
 */

export type ProductSearchMode = 'exact' | 'contains'

/** Campos en los que busca cada superficie. Son los mismos que usaba cada una antes. */
export const PRODUCT_SEARCH_FIELDS = {
  storefront: ['name', 'slug', 'description', 'brand'],
  admin: ['name', 'slug', 'description'],
  posProduct: ['name', 'slug', 'brand'],
  posVariant: ['sku', 'barcode', 'description'],
  assistant: ['name', 'slug'],
} as const satisfies Record<string, readonly string[]>

/** Longitud máxima del texto buscado y número máximo de palabras. */
export const SEARCH_MAX_CHARS = 120
export const SEARCH_MAX_WORDS = 6

const STOPWORDS = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'un', 'una', 'con', 'para', 'por', 'y'])

const ACCENT_CLASSES: Record<string, string> = {
  a: '[aáàäâ]',
  e: '[eéèëê]',
  i: '[iíìïî]',
  o: '[oóòöô]',
  u: '[uúùüû]',
  n: '[nñ]',
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Patrón (ya escapado) que coincide con y sin tildes. Seguro: el escape no deja letras tras `\`. */
export function accentInsensitivePattern(text: string): string {
  return escapeRegex(text.normalize('NFD').replace(/[̀-ͯ]/g, '')).replace(
    /[aeioun]/gi,
    (ch) => ACCENT_CLASSES[ch.toLowerCase()] ?? ch,
  )
}

/** Texto normalizado para buscar: espacios colapsados y longitud acotada. */
export function normalizeSearchText(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, SEARCH_MAX_CHARS)
}

/**
 * Palabras para el modo `contains`. Se quitan las palabras vacías ("de", "la"…) salvo que la
 * búsqueda solo tenga palabras vacías, para no convertir "de" en "todo el catálogo".
 */
export function searchWords(raw: string): string[] {
  const words = normalizeSearchText(raw).split(' ').filter(Boolean)
  const meaningful = words.filter((w) => !STOPWORDS.has(w.toLowerCase()))
  return (meaningful.length ? meaningful : words).slice(0, SEARCH_MAX_WORDS)
}

/**
 * Filtro de MongoDB para buscar `raw` en `fields`. Devuelve null si no hay nada que buscar (cada
 * llamador decide si eso significa "sin filtro" o "sin resultados").
 */
export function productTextFilter(
  raw: string,
  fields: readonly string[],
  mode: ProductSearchMode = 'contains',
): Record<string, unknown> | null {
  const text = normalizeSearchText(raw)
  if (!text || fields.length === 0) return null
  if (mode === 'exact') {
    const pattern = `^${accentInsensitivePattern(text)}$`
    return { $or: fields.map((field) => ({ [field]: { $regex: pattern, $options: 'i' } })) }
  }
  const clauses = searchWords(text).map((word) => {
    const pattern = accentInsensitivePattern(word)
    return { $or: fields.map((field) => ({ [field]: { $regex: pattern, $options: 'i' } })) }
  })
  if (clauses.length === 0) return null
  return clauses.length === 1 ? clauses[0]! : { $and: clauses }
}

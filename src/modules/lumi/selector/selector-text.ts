import { normalizeText } from '../automation/domain/reminder-parser.js'

/**
 * Utilidades de texto del selector. Puerto de `local-ai-assistant/bench/rules.py` (especificación
 * medida con los bancos de entrenamiento, validación y control).
 */

/** Texto en minúsculas, sin tildes y sin signos: solo letras, números, espacios, ":" y "-". */
export function plainText(text: string): string {
  return normalizeText(text)
    .replace(/[^a-z0-9 :-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Palabras que no identifican nada por sí solas: si el modelo solo pone esto, el dato falta. */
const GENERIC_WORDS = new Set(
  (
    'producto productos promocion promociones promo pedido pedidos orden ordenes stock inventario articulo ' +
    'articulos item cosa algo eso esto este ese esta esa mi mis su sus el la los las lo un una unos unas de ' +
    'del al a y o que cuanto cuanta cuantos cuantas queda quedan hay tiene tengo para por con en sin me te se le les nos'
  ).split(' '),
)

export function contentWords(value: string): string[] {
  return plainText(value)
    .split(' ')
    .filter((w) => w.length > 0 && !GENERIC_WORDS.has(w))
}

/**
 * Misma palabra o la misma raíz ("revisa"/"revisar", "vela"/"velas"). Las palabras cortas y los
 * números tienen que coincidir exactamente.
 */
export function sameWord(a: string, b: string): boolean {
  if (a === b) return true
  if (a.length < 4 || b.length < 4) return false
  const stem = Math.min(5, a.length, b.length)
  return a.slice(0, stem) === b.slice(0, stem)
}

/**
 * Un texto propuesto por el modelo solo vale si alguna de sus palabras significativas aparece en
 * el mensaje o en la entidad activa. Así se descartan "mi pedido", "producto" o datos inventados.
 */
export function grounded(value: unknown, message: string, entityLabel = ''): boolean {
  if (typeof value !== 'string') return false
  const source = [...plainText(message).split(' '), ...plainText(entityLabel).split(' ')].filter(Boolean)
  return contentWords(value).some((word) => source.some((other) => sameWord(word, other)))
}

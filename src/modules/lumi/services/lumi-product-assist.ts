import { z } from 'zod'
import { AppError } from '../../../common/errors/app.error.js'

/**
 * Asistencia de contenido para productos. Las instrucciones las escribe el servidor (el navegador
 * solo elige la acción y el tono). La sugerencia nunca se guarda: el administrador la revisa y la
 * aplica en el formulario, y se guarda solo al confirmar.
 */

export const PRODUCT_ASSIST_ACTIONS = [
  'generate_title',
  'generate_description',
  'improve_description',
  'fix_spelling',
  'change_tone',
  'seo_title',
  'meta_description',
] as const
export type ProductAssistAction = (typeof PRODUCT_ASSIST_ACTIONS)[number]

export const PRODUCT_ASSIST_TONES = ['commercial', 'friendly', 'formal'] as const
export type ProductAssistTone = (typeof PRODUCT_ASSIST_TONES)[number]

const TONE_LABEL: Record<ProductAssistTone, string> = {
  commercial: 'comercial y persuasivo',
  friendly: 'cercano y amable',
  formal: 'formal y sobrio',
}

export const lumiProductAssistSchema = z.object({
  action: z.enum(PRODUCT_ASSIST_ACTIONS),
  tone: z.enum(PRODUCT_ASSIST_TONES).optional(),
  /** Texto actual del campo en el formulario (puede tener cambios sin guardar). */
  text: z.string().trim().max(8000).optional(),
})
export type LumiProductAssistInput = z.infer<typeof lumiProductAssistSchema>

/** Campos del producto que usa la asistencia. */
export interface ProductAssistSource {
  product: {
    name: string
    categorySlug: string | null
    brand: string | null
    description: string | null
  }
}

const BASE_RULES = [
  'Eres el redactor de la tienda Lumia. Escribe en español neutro.',
  'Responde únicamente con el texto pedido: sin comillas, títulos, viñetas ni explicaciones.',
  'No inventes materiales, medidas, certificaciones, duraciones ni ningún dato que no aparezca en el texto de trabajo.',
  'Si falta información, escribe de forma general y no afirmes datos concretos.',
].join(' ')

const ACTION_RULES: Record<ProductAssistAction, string> = {
  generate_title:
    'Escribe un título comercial corto para el producto, de máximo 80 caracteres y sin punto final, en una sola línea.',
  generate_description:
    'Escribe una descripción comercial para el producto en 2 o 3 párrafos cortos, en texto plano (sin Markdown).',
  improve_description:
    'Mejora la descripción dada: más clara y atractiva, conservando todos sus datos. Devuelve la descripción completa en texto plano.',
  fix_spelling:
    'Corrige la ortografía, las tildes y la puntuación del texto dado, sin cambiar su contenido ni su tono. Devuelve el texto completo en texto plano.',
  change_tone: '',
  seo_title:
    'Escribe un título SEO de máximo 60 caracteres que incluya el nombre del producto, en una sola línea y sin comillas.',
  meta_description:
    'Escribe una meta descripción SEO de entre 120 y 155 caracteres, en una sola línea y sin comillas.',
}

/** Acciones que necesitan un texto de partida (si no hay, se responde 422). */
const NEEDS_TEXT: ReadonlySet<ProductAssistAction> = new Set([
  'improve_description',
  'fix_spelling',
  'change_tone',
])

/** Límite de tokens de salida por acción: títulos cortos, descripciones completas. */
const MAX_TOKENS: Record<ProductAssistAction, number> = {
  generate_title: 60,
  generate_description: 700,
  improve_description: 700,
  fix_spelling: 700,
  change_tone: 700,
  seo_title: 60,
  meta_description: 120,
}

export interface AssistRequest {
  instructions: string
  input: string
  maxTokens: number
}

function summaryOf(source: ProductAssistSource): string {
  const p = source.product
  return [
    `Producto: ${p.name}`,
    `Categoría: ${p.categorySlug ?? 'sin categoría'}`,
    `Marca: ${p.brand ?? 'sin marca'}`,
  ].join('\n')
}

/** Construye instrucciones (fijas) y entrada (datos del producto y texto de trabajo). */
export function buildAssistRequest(
  input: LumiProductAssistInput,
  source: ProductAssistSource,
): AssistRequest {
  const { action } = input
  const working = input.text?.trim() || ''
  if (NEEDS_TEXT.has(action) && !working) {
    throw new AppError(422, 'Escribe primero el texto que quieres mejorar.', 'UNPROCESSABLE')
  }

  const rule =
    action === 'change_tone'
      ? `Reescribe el texto con un tono ${TONE_LABEL[input.tone ?? 'commercial']}, conservando todos sus datos. Devuelve el texto completo en texto plano.`
      : ACTION_RULES[action]

  const text = working || source.product.description?.trim() || ''
  const body = [
    summaryOf(source),
    text ? `Texto de trabajo:\n${text}` : 'Texto de trabajo: (vacío)',
  ]

  return {
    instructions: `${BASE_RULES} ${rule}`,
    input: body.join('\n\n'),
    maxTokens: MAX_TOKENS[action],
  }
}

/** Limpia la salida del modelo y aplica límites antes de mostrarla. Nunca devuelve vacío. */
export function sanitizeSuggestion(action: ProductAssistAction, raw: string): string {
  let text = raw
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/^\s*#+\s*/gm, '')
    .trim()
    .replace(/^["'“”«»]+|["'“”«»]+$/g, '')
    .trim()

  const singleLine =
    action === 'generate_title' || action === 'seo_title' || action === 'meta_description'
  if (singleLine) text = text.replace(/\s+/g, ' ').trim()

  const max =
    action === 'generate_title'
      ? 120
      : action === 'seo_title'
        ? 60
        : action === 'meta_description'
          ? 160
          : 8000
  if (text.length > max) text = text.slice(0, max).trim()

  if (!text)
    throw new AppError(
      502,
      'La IA no devolvió una sugerencia. Inténtalo de nuevo.',
      'LUMI_EMPTY_SUGGESTION',
    )
  return text
}

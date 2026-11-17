import { z } from 'zod'

/**
 * Referencias estructuradas de un mensaje de Lumi. Permiten que el chat abra el registro, el
 * módulo o la fuente de donde sale cada dato de la respuesta.
 *
 * Reglas:
 *  - El Server las arma a partir de los resultados reales de las herramientas (ids leídos de la
 *    base de datos) o de los metadatos que devolvió el buscador web. El modelo nunca las escribe.
 *  - No llevan rutas: Lumia Admin traduce `entity`/`module` a su ruta con una lista cerrada.
 *  - Se guardan con el mensaje en ia-asistente, así el historial las conserva sin repetir consultas.
 *  - Todo lo que vuelve de ia-asistente se valida otra vez aquí; lo que no cumple se descarta.
 */

export const LUMI_REFERENCE_ENTITIES = ['product', 'category', 'order', 'promotion'] as const
export type LumiReferenceEntity = (typeof LUMI_REFERENCE_ENTITIES)[number]

export const LUMI_REFERENCE_MODULES = [
  'dashboard',
  'analytics',
  'orders',
  'products',
  'inventory',
  'categories',
  'promotions',
  'notifications',
  'initiatives',
  'automations',
] as const
export type LumiReferenceModule = (typeof LUMI_REFERENCE_MODULES)[number]

export const LUMI_REFERENCE_REPORTS = ['sales'] as const

/** Máximo de referencias por mensaje (ia-asistente acepta hasta 60). */
export const LUMI_REFERENCES_MAX = 60
const LABEL_MAX = 160

const objectId = z.string().regex(/^[a-f0-9]{24}$/i)
const label = z.string().trim().min(1).max(LABEL_MAX)

/** Solo http(s) y sin credenciales en la URL. Cualquier otra cosa deja la fuente sin enlace. */
export function safeExternalUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (url.username || url.password) return null
    return url.toString()
  } catch {
    return null
  }
}

const clip = (max: number) => (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.replace(/\s+/g, ' ').trim().slice(0, max) : null

export const lumiReferenceSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('admin_entity'),
    entity: z.enum(LUMI_REFERENCE_ENTITIES),
    id: objectId,
    label,
  }),
  z.object({ type: z.literal('admin_module'), module: z.enum(LUMI_REFERENCE_MODULES), label }),
  z.object({ type: z.literal('report'), report: z.enum(LUMI_REFERENCE_REPORTS), label }),
  /** Resultado de una operación ejecutada por Lumi; abre el módulo donde quedó registrada. */
  z.object({
    type: z.literal('operation'),
    module: z.enum(LUMI_REFERENCE_MODULES),
    status: z.enum(['success', 'failed']),
    label,
  }),
  z.object({
    type: z.literal('web_source'),
    index: z.number().int().min(1).max(50),
    title: z.preprocess(clip(300), z.string().nullable()),
    url: z.preprocess(safeExternalUrl, z.string().nullable()),
    domain: z.preprocess(clip(120), z.string().nullable()),
    snippet: z.preprocess(clip(400), z.string().nullable()),
    cited: z.boolean().default(false),
  }),
])

export type LumiReference = z.infer<typeof lumiReferenceSchema>

/**
 * Valida una lista que viene de fuera (ia-asistente). Descarta las referencias inválidas una a una:
 * un dato raro nunca impide mostrar el mensaje. Sin lista, devuelve [] (mensajes antiguos).
 */
export function parseLumiReferences(raw: unknown): LumiReference[] {
  if (!Array.isArray(raw)) return []
  const out: LumiReference[] = []
  for (const item of raw.slice(0, LUMI_REFERENCES_MAX)) {
    const parsed = lumiReferenceSchema.safeParse(item)
    if (parsed.success) out.push(parsed.data)
  }
  return out
}

/** Referencia a un registro. Sin id válido no hay referencia (nunca se inventa una). */
export function entityRef(
  entity: LumiReferenceEntity,
  id: string | null | undefined,
  text: string,
): LumiReference | null {
  const parsed = lumiReferenceSchema.safeParse({
    type: 'admin_entity',
    entity,
    id,
    label: text.trim().slice(0, LABEL_MAX),
  })
  return parsed.success ? parsed.data : null
}

export function moduleRef(module: LumiReferenceModule, text: string): LumiReference {
  return { type: 'admin_module', module, label: text }
}

export function compactRefs(refs: Array<LumiReference | null | undefined>): LumiReference[] {
  return refs.filter((r): r is LumiReference => r != null).slice(0, LUMI_REFERENCES_MAX)
}

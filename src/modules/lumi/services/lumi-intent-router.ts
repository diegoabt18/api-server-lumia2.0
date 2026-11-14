/**
 * Router de intenciones por reglas. Decide si un mensaje se resuelve con una herramienta del
 * backend (sin modelo) o si debe ir a Qwen. Sin coincidencia clara, siempre se usa el modelo.
 */

export type LumiRoute = { kind: 'model' } | { kind: 'orders_recent'; limit: number }

/** Control del administrador: automático (decide el servidor), activado o desactivado. */
export type LumiMode = 'auto' | 'on' | 'off'

const CURRENT_EVENTS = /(actualidad|actualmente|noticias|quién es (el|la) (actual )?(presidente|presidenta|alcalde|alcaldesa)|últimas? noticias)/i
/** Datos del mundo real que cambian a diario (clima, divisas). No son datos de la tienda. */
const LIVE_WORLD_DATA =
  /(clima|pron[oó]stico|temperatura|cu[aá]ntos grados|grados (hace|hay|est[aá])|llover|llueve|lluvia|qu[eé] tiempo hace|precio del d[oó]lar|d[oó]lar (de )?hoy)/i
const DEEP_ANALYSIS = /(compara|comparar|comparación|contradic|más confiable|analiza|análisis|investiga)/i

/**
 * Reglas de modo automático para búsqueda web: actualidad y datos del mundo real que cambian
 * (clima, divisas). Nunca se activa por el volumen de texto ni por datos de la tienda.
 */
export function needsWebSearch(message: string): boolean {
  return CURRENT_EVENTS.test(message) || LIVE_WORLD_DATA.test(message)
}

/** Reglas de modo automático para razonamiento: comparaciones y análisis, no preguntas sencillas. */
export function needsReasoning(message: string): boolean {
  return DEEP_ANALYSIS.test(message)
}

export interface ResolvedModes {
  reasoning: boolean
  webSearch: boolean
  /** El administrador pidió búsqueda web de forma explícita sin tener el permiso. */
  webDenied: boolean
}

/**
 * Resuelve los controles del chat. El modo manual siempre tiene prioridad sobre las reglas.
 * Sin permiso de búsqueda web, el modo automático se queda en "sin búsqueda" sin error.
 */
export function resolveLumiModes(input: {
  message: string
  reasoningMode: LumiMode
  webMode: LumiMode
  canWeb: boolean
}): ResolvedModes {
  const reasoning =
    input.reasoningMode === 'on' ||
    (input.reasoningMode === 'auto' && needsReasoning(input.message))
  const webWanted =
    input.webMode === 'on' || (input.webMode === 'auto' && needsWebSearch(input.message))
  return {
    reasoning,
    webSearch: webWanted && input.canWeb,
    webDenied: input.webMode === 'on' && !input.canWeb,
  }
}

export const ORDERS_RECENT_DEFAULT = 10
export const ORDERS_RECENT_MAX = 50

const ORDERS_WORD = /pedidos?/i
const RECENT_WORD = /(últimos?|ultimos?|recientes?|más recientes|mas recientes)/i
const COUNT_WORD = /\b(\d{1,2})\b/

export function routeMessage(message: string): LumiRoute {
  const text = message.trim()
  if (!ORDERS_WORD.test(text) || !RECENT_WORD.test(text)) return { kind: 'model' }

  const count = COUNT_WORD.exec(text)
  const requested = count ? Number(count[1]) : ORDERS_RECENT_DEFAULT
  const limit = Math.min(Math.max(requested, 1), ORDERS_RECENT_MAX)
  return { kind: 'orders_recent', limit }
}

/**
 * Reglas del modo automático (búsqueda web y razonamiento). Qué mensajes resuelve una herramienta
 * sin modelo lo decide el catálogo (modules/lumi/tools/catalog.ts).
 */

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

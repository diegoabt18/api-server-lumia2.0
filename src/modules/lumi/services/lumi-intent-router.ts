/**
 * Router de intenciones por reglas. Decide si un mensaje se resuelve con una herramienta del
 * backend (sin modelo) o si debe ir a Qwen. Sin coincidencia clara, siempre se usa el modelo.
 */

export type LumiRoute = { kind: 'model' } | { kind: 'orders_recent'; limit: number }

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

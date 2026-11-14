import type { InitiativeKind, InitiativePriority } from './initiative.types.js'

/**
 * Detectores puros: reciben filas ya leídas y devuelven candidatos. No tocan la base de datos, así que
 * se prueban sin Mongo. Los umbrales se pasan como parámetros para que la configuración viva en un solo sitio.
 */

export interface InitiativeCandidate {
  kind: InitiativeKind
  /** Identifica el sujeto (slug, id de pedido o de rutina): junto con kind forma la clave de deduplicación. */
  subjectKey: string
  title: string
  detail: string
  priority: InitiativePriority
}

export const DAY_MS = 24 * 60 * 60 * 1000

export interface StockRow {
  slug: string
  name: string
  /** Unidades disponibles (cantidad menos reservado). */
  available: number
}

/** Sin stock = prioridad 3. Stock bajo (<= umbral) = prioridad 2. */
export function detectStock(rows: readonly StockRow[], lowThreshold: number): InitiativeCandidate[] {
  const out: InitiativeCandidate[] = []
  for (const row of rows) {
    if (row.available <= 0) {
      out.push({
        kind: 'stock',
        subjectKey: row.slug,
        title: 'Producto sin stock',
        detail: `${row.name} no tiene unidades disponibles.`,
        priority: 3,
      })
    } else if (row.available <= lowThreshold) {
      out.push({
        kind: 'stock',
        subjectKey: row.slug,
        title: 'Stock bajo',
        detail: `Quedan ${row.available} unidades de ${row.name}.`,
        priority: 2,
      })
    }
  }
  return out
}

export interface PaidOrderRow {
  id: string
  orderNumber: string | null
  createdAt: Date
}

/** Pedido pagado sin despachar desde hace `staleDays` días. Prioridad 3 al doble de ese plazo. */
export function detectStaleOrders(rows: readonly PaidOrderRow[], now: Date, staleDays: number): InitiativeCandidate[] {
  const out: InitiativeCandidate[] = []
  for (const row of rows) {
    const ageDays = (now.getTime() - row.createdAt.getTime()) / DAY_MS
    if (ageDays < staleDays) continue
    const ref = row.orderNumber ?? row.id
    out.push({
      kind: 'order_attention',
      subjectKey: row.id,
      title: 'Pedido pagado sin despachar',
      detail: `El pedido ${ref} lleva ${Math.floor(ageDays)} días pagado y sin despachar.`,
      priority: ageDays >= staleDays * 2 ? 3 : 2,
    })
  }
  return out
}

export interface FailedRoutineRow {
  taskId: string
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'dead' | 'skipped'
  finishedAt: Date | null
}

/** Ejecuciones agotadas (dead) dentro de la ventana reciente. */
export function detectFailedRoutines(
  rows: readonly FailedRoutineRow[],
  now: Date,
  windowDays: number,
): InitiativeCandidate[] {
  const out: InitiativeCandidate[] = []
  for (const row of rows) {
    if (row.status !== 'dead' || !row.finishedAt) continue
    if (now.getTime() - row.finishedAt.getTime() > windowDays * DAY_MS) continue
    out.push({
      kind: 'routine_failed',
      subjectKey: row.taskId,
      title: 'Un recordatorio no se pudo entregar',
      detail: 'Un recordatorio falló varias veces seguidas. Revisa la rutina.',
      priority: 2,
    })
  }
  return out
}

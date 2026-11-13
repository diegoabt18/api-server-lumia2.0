/**
 * Herramienta de solo lectura: pedidos recientes. Responde con texto determinista, sin modelo.
 * No incluye datos del cliente (nombre, correo, teléfono): solo número, fecha, estado e importe.
 */

export interface RecentOrderRow {
  orderNumber: string | null
  createdAt: string | null
  status: string | null
  paymentStatus: string | null
  total: number | null
}

function text(value: string | null | undefined): string {
  return value && value.trim() ? value.trim() : '—'
}

function day(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : '—'
}

export function formatRecentOrders(rows: ReadonlyArray<RecentOrderRow>, limit: number): string {
  if (rows.length === 0) return 'No hay pedidos registrados.'

  const lines = rows.map(
    (row, index) =>
      `${index + 1}. #${text(row.orderNumber)} · ${day(row.createdAt)} · estado: ${text(row.status)} · pago: ${text(row.paymentStatus)} · total: ${row.total ?? '—'}`,
  )
  const heading = rows.length < limit ? `Pedidos (${rows.length}):` : `Últimos ${rows.length} pedidos:`
  return [heading, ...lines].join('\n')
}

export const NO_ORDERS_PERMISSION_ANSWER = 'No tienes permiso para consultar pedidos.'

/**
 * Respuesta completa de la herramienta. Sin permiso no se lee nada: `fetchRows` no se llama.
 */
export async function answerRecentOrders(
  canRead: boolean,
  limit: number,
  fetchRows: (limit: number) => Promise<RecentOrderRow[]>,
): Promise<string> {
  if (!canRead) return NO_ORDERS_PERMISSION_ANSWER
  return formatRecentOrders(await fetchRows(limit), limit)
}

import type { PermissionId } from '../../../common/permissions/registry.js'
import type { LumiInitiative } from '../initiatives/domain/initiative.types.js'

/**
 * Catálogo de herramientas de Lumi. Una herramienta es una consulta de SOLO LECTURA que el Server
 * ejecuta con los permisos del usuario y responde con texto determinista (plantilla), sin modelo.
 *
 * Reglas del catálogo:
 *  - Nunca hay "ejecutar endpoint arbitrario": solo las herramientas registradas aquí.
 *  - El permiso se comprueba en el Server antes de leer nada; el modelo no participa en esa decisión.
 *  - La entrada se valida (forma cerrada) y los resultados se acotan en filas y en longitud.
 *  - No se devuelven datos personales de clientes (nombre, correo, teléfono, dirección).
 */

export type LumiToolName =
  | 'orders.lookup'
  | 'orders.count'
  | 'orders.recent'
  | 'sales.summary'
  | 'inventory.low'
  | 'products.search'
  | 'initiatives.list'
  | 'notifications.unread'

/** Fila de pedido sin datos del cliente. */
export interface AssistantOrderRow {
  orderNumber: string | null
  reference: string | null
  createdAt: string | null
  status: string | null
  paymentStatus: string | null
  fulfillmentStatus: string | null
  total: number | null
  itemCount: number
}

export interface AssistantProductRow {
  name: string
  status: string
  available: number
  minPrice: number | null
  maxPrice: number | null
}

export interface AssistantSalesSummary {
  /** Pedidos creados en el periodo, en cualquier estado. */
  orders: number
  /** Pedidos que cuentan como venta (pagados, enviados o entregados). */
  soldOrders: number
  revenue: number
  refunds: number
  topProducts: Array<{ name: string; units: number; revenue: number }>
}

/**
 * Puertos de lectura que usan las herramientas. Se implementan con los repositorios del Server
 * (ver tool-adapters.ts) y con dobles en las pruebas.
 */
export interface LumiToolDeps {
  orders: {
    recent(limit: number): Promise<AssistantOrderRow[]>
    findByReference(term: string, limit: number): Promise<AssistantOrderRow[]>
    countByStatus(range?: { from: Date; to: Date }): Promise<Record<string, number>>
    salesSummary(from: Date, to: Date): Promise<AssistantSalesSummary>
  }
  products: {
    lowStock(threshold: number, limit: number): Promise<Array<{ name: string; available: number }>>
    search(term: string, limit: number): Promise<AssistantProductRow[]>
  }
  initiatives: {
    list(userId: string, keys: readonly PermissionId[], limit: number): Promise<LumiInitiative[]>
  }
  notifications: {
    countUnread(userId: string): Promise<number>
    recentUnread(userId: string, limit: number): Promise<Array<{ title: string; createdAt: string }>>
  }
}

export interface LumiToolContext {
  userId: string
  permissionKeys: readonly PermissionId[]
  now: Date
  timezone: string
  deps: LumiToolDeps
}

export interface LumiToolResult {
  /** Respuesta lista para mostrar (también se guarda en el historial). */
  text: string
  /** Filas leídas, para el indicador de actividad del chat. */
  rows: number
}

export interface LumiTool<I> {
  name: LumiToolName
  /** Etiqueta corta para el chat ("Consultando pedidos"). */
  label: string
  /** Capacidad y frase de ejemplo, para el prompt de capacidades y la ayuda. */
  capability: string
  example: string
  /** null = cualquier usuario con lumi.use. */
  permission: PermissionId | null
  /** Regla determinista: devuelve la entrada validada o null si el mensaje no es para esta herramienta. */
  match(normalized: string, original: string, ctx: Pick<LumiToolContext, 'now' | 'timezone'>): I | null
  run(ctx: LumiToolContext, input: I): Promise<LumiToolResult>
}

/** Límite de caracteres de una respuesta de herramienta (el historial acepta hasta 8000). */
export const TOOL_TEXT_MAX_CHARS = 3500

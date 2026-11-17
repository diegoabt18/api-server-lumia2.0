import type { PermissionId } from '../../../common/permissions/registry.js'
import type { LumiInitiative } from '../initiatives/domain/initiative.types.js'
import type { LumiReference } from '../references/lumi-references.js'

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
  | 'products.unpriced'
  | 'products.untaxed'
  | 'products.taxed'
  | 'categories.list'

/** Fila de pedido sin datos del cliente. */
export interface AssistantOrderRow {
  /** Id del pedido, para abrirlo desde el chat. Nunca se muestra en el texto. */
  id: string | null
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
  id: string
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
    lowStock(threshold: number, limit: number): Promise<Array<{ id: string | null; name: string; available: number }>>
    /** Productos sin ninguna variante con precio mayor que cero (fase E). */
    unpriced(limit: number): Promise<{ items: Array<{ id: string; name: string; status: string; variantCount: number }>; total: number }>
    /** Productos sin IVA configurado (tax_rate ausente o no numérico). */
    untaxed(limit: number): Promise<{ items: Array<{ id: string; name: string; status: string }>; total: number }>
    /** Productos con IVA configurado (tax_rate numérico, 0 % incluido), en orden alfabético. */
    taxed(limit: number): Promise<{ items: Array<{ id: string; name: string; status: string; taxRate: number }>; total: number }>
    search(term: string, limit: number): Promise<AssistantProductRow[]>
  }
  categories: {
    /** Categorías en orden alfabético (activas e inactivas) con su número de productos. */
    list(limit: number): Promise<{ items: Array<{ id: string; name: string; status: string; productCount: number }>; total: number }>
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

/** Entidad que una respuesta deja "abierta" para el turno siguiente ("¿y sus pagos?"). */
export interface LumiEntityRef {
  kind: 'order' | 'product'
  /** Referencia del pedido o nombre del producto, tal como se muestra. Nunca datos de clientes. */
  label: string
}

export interface LumiToolResult {
  /** Respuesta lista para mostrar (también se guarda en el historial). */
  text: string
  /** Filas leídas, para el indicador de actividad del chat. */
  rows: number
  /** Si la respuesta trata de una sola entidad, queda como contexto del turno siguiente. */
  entity?: LumiEntityRef
  /**
   * Registros y módulos de los que salen los datos, con sus ids reales. El chat los muestra como
   * accesos (icono de ojo, enlace al módulo) y se guardan con el mensaje en el historial.
   */
  references?: LumiReference[]
}

/**
 * Módulos de la tienda. El selector indica a cuál se refiere una petición; cuando no hay
 * herramienta, el módulo permite registrar la capacidad que falta donde corresponde.
 */
export const LUMI_MODULES = [
  'productos',
  'inventario',
  'pedidos',
  'pagos',
  'ventas',
  'clientes',
  'promociones',
  'banners',
  'categorias',
  'resenas',
  'produccion',
  'usuarios',
  'configuracion',
  'recordatorios',
  'notificaciones',
  'iniciativas',
] as const
export type LumiModule = (typeof LUMI_MODULES)[number]

/** Tipo de un argumento tal como lo ve el modelo: texto, entero, booleano o lista cerrada. */
export type LumiSelectorArgKind = 'str' | 'int' | 'bool' | readonly string[]

export interface LumiSelectorArg {
  name: string
  kind: LumiSelectorArgKind
  required?: boolean
  description?: string
}

/** Lo que construye `fromArgs`: la entrada validada, o los datos obligatorios que faltan. */
export type LumiSelectorBuild<I> = { input: I } | { missing: string[] }

/**
 * Cómo ve una herramienta el selector (etapa 2). El modelo solo PROPONE la herramienta y sus
 * argumentos; `fromArgs` (Server) construye la entrada: los valores cerrados (periodos, estados)
 * salen del mensaje, nunca del modelo.
 */
export interface LumiToolSelector<I> {
  description: string
  module: LumiModule
  args: readonly LumiSelectorArg[]
  /** Pregunta al usuario cuando falta un dato obligatorio. */
  ask?: string
  fromArgs(
    args: Readonly<Record<string, unknown>>,
    normalized: string,
    ctx: Pick<LumiToolContext, 'now' | 'timezone'>,
  ): LumiSelectorBuild<I>
}

export interface LumiTool<I> {
  name: LumiToolName
  /**
   * Clave de la capacidad en `lumi_capabilities` (fase E). Con ella el Server sabe que la capacidad
   * está implementada; si está habilitada lo decide la base de datos, no el código.
   */
  capabilityKey: string
  /**
   * Solo las herramientas anteriores a la fase E: al migrar se dan de alta habilitadas para no
   * cambiar el comportamiento. Una herramienta nueva NO lo declara y arranca deshabilitada.
   */
  enabledByDefault?: true
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
  /** Sin `selector`, la herramienta solo se usa por reglas (etapa 1). */
  selector?: LumiToolSelector<I>
}

/** Límite de caracteres de una respuesta de herramienta (el historial acepta hasta 8000). */
export const TOOL_TEXT_MAX_CHARS = 3500

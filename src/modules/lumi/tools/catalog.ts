import { PERMISSION_REGISTRY, hasPermission, type PermissionId } from '../../../common/permissions/registry.js'
import { normalizeText } from '../automation/domain/reminder-parser.js'
import { parseTimeRange, todayRange, type TimeRange } from './time-range.js'
import {
  TOOL_TEXT_MAX_CHARS,
  type AssistantOrderRow,
  type LumiTool,
  type LumiToolContext,
  type LumiToolResult,
} from './tool.types.js'
import { productsUnpriced } from './products-unpriced.tool.js'

/* ───────────────────────── Formato ───────────────────────── */

const STATUS_LABELS: Record<string, string> = {
  pending: 'pendiente de pago',
  paid: 'pagado, por despachar',
  shipped: 'enviado',
  delivered: 'entregado',
  cancelled: 'cancelado',
  expired: 'vencido',
}

export function statusLabel(status: string | null | undefined): string {
  if (!status) return '—'
  return STATUS_LABELS[status] ?? status
}

export function formatMoney(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return `$${Math.round(value).toLocaleString('es-CO')}`
}

function formatDay(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '—'
}

function clipText(text: string): string {
  return text.length > TOOL_TEXT_MAX_CHARS ? `${text.slice(0, TOOL_TEXT_MAX_CHARS - 1)}…` : text
}

function result(text: string, rows: number, entity?: LumiToolResult['entity']): LumiToolResult {
  return entity ? { text: clipText(text), rows, entity } : { text: clipText(text), rows }
}

/** Texto que propone el modelo: se acepta como cadena corta, nunca como otro tipo. */
function argText(value: unknown, max = 60): string | null {
  if (typeof value !== 'string') return null
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > 0 && text.length <= max ? text : null
}

const PERIOD_VALUES = ['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month', 'last_7_days', 'last_30_days', 'last_90_days'] as const
const STATUS_VALUES = ['pending', 'paid', 'shipped', 'delivered', 'cancelled', 'expired', 'open'] as const

function orderLine(row: AssistantOrderRow, index?: number): string {
  const ref = row.reference ?? row.orderNumber ?? '—'
  const prefix = index === undefined ? '' : `${index + 1}. `
  const items = row.itemCount === 1 ? '1 artículo' : `${row.itemCount} artículos`
  return `${prefix}${ref} · ${formatDay(row.createdAt)} · ${statusLabel(row.status)} · pago: ${row.paymentStatus ?? '—'} · ${items} · total ${formatMoney(row.total)}`
}

/* ───────────────────────── Reglas ───────────────────────── */

const ORDERS_WORD = /\b(pedidos?|ordenes?)\b/
const RECENT_WORD = /\b(ultimos?|recientes?)\b/
const COUNT_WORD = /\bcuant[oa]s\b/
const ORDER_STATUS_WORDS: Array<[RegExp, string[]]> = [
  [/\b(por despachar|sin despachar|por enviar|sin enviar|pagados?)\b/, ['paid']],
  [/\b(por pagar|sin pagar|pendientes? de pago)\b/, ['pending']],
  [/\b(pendientes?|abiertos?|en curso|activos?)\b/, ['pending', 'paid', 'shipped']],
  [/\b(enviados?|en camino)\b/, ['shipped']],
  // "entregados", "entregamos", "se entregaron"; "cancelados", "se cancelaron".
  [/\b(entreg(?:ad[oa]s?|amos|aron|o))\b/, ['delivered']],
  [/\b(cancel(?:ad[oa]s?|amos|aron|o))\b/, ['cancelled']],
  [/\b(vencidos?|expirados?)\b/, ['expired']],
]
/** Referencia de pedido: ORD-XXXXXXXX, el número interno completo o "pedido 1A2B3C4D". */
const ORDER_REF = /\b(ord-\d{8}-\d{6}-[0-9a-f]{8}|ord-[0-9a-f]{4,8})\b/
const ORDER_TOKEN = /\b(?:pedido|orden)\s*(?:numero|no\.?|nro\.?)?\s*#?\s*([a-z0-9-]{4,40})\b/
const SALES_WORD = /\b(ventas?|vend[ia]\w*|ingresos?|facturacion|factur[eo]\w*|ticket promedio)\b/
const TOP_SELLERS = /\bmas vendid[oa]s\b/
const INVENTORY_WORD =
  /\b(sin stock|stock bajo|bajo stock|poco stock|agotad[oa]s?|agotandose|se (esta|estan) agotando|por agotarse|reponer|reposicion|inventario critico|que (me )?falta reponer)\b/
const PRODUCT_PATTERNS: RegExp[] = [
  /\b(?:stock|existencias|unidades|disponibilidad|inventario) (?:de|del|de la|de los|de las|para) (.+)$/,
  /\bcuant[oa]s? (?:unidades |stock |existencias )?(?:quedan|hay|tengo|tenemos|queda) (?:de|del|de la|de los|de las) (.+)$/,
  /\bprecio (?:de|del|de la|de los|de las) (.+)$/,
  /\bbusca(?:r|me)? (?:el |la |los |las |un |una )?productos? (.+)$/,
]
const INITIATIVES_WORD = /\biniciativas?\b/
const NOTIFICATIONS_WORD = /\b(notificaciones|avisos)\b/
const LISTING_HINT = /(pendiente|urgente|abierta|tengo|hay|muestr|cual|lista|nueva|ver\b|revis|sin leer|cuant)/

function cleanTerm(raw: string): string | null {
  const term = raw
    .replace(/[?¿!¡.,;:"'«»]+/g, ' ')
    .replace(/^\s*(el|la|los|las|un|una|producto|productos)\s+/g, '')
    .replace(/\s+(hoy|ahora|actualmente|por favor)\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return term.length >= 2 && term.length <= 60 ? term : null
}

/** "dame un análisis", "¿por qué bajaron…?": la herramienta aporta los datos y el modelo explica. */
const EXPLANATION_INTENT =
  /\b(por que|porque|explica\w*|analiza\w*|analisis|compara\w*|que opinas|recomienda\w*|a que se debe|interpreta\w*)\b/

export function wantsExplanation(normalized: string): boolean {
  return EXPLANATION_INTENT.test(normalized)
}

/* ───────────────────────── Herramientas ───────────────────────── */

const ordersLookup: LumiTool<{ term: string }> = {
  name: 'orders.lookup',
  capabilityKey: 'tool-orders-lookup',
  enabledByDefault: true,
  label: 'Buscando el pedido',
  capability: 'Ver el estado de un pedido por su referencia',
  example: '¿Cómo va el pedido ORD-CB07203E?',
  permission: PERMISSION_REGISTRY.ORDERS_READ,
  match(text) {
    const ref = ORDER_REF.exec(text)
    if (ref) return { term: ref[1]! }
    const token = ORDER_TOKEN.exec(text)
    if (token && /\d/.test(token[1]!) && !COUNT_WORD.test(text)) return { term: token[1]! }
    return null
  },
  selector: {
    description: 'Estado de un pedido por su referencia (ORD-...)',
    module: 'pedidos',
    args: [{ name: 'reference', kind: 'str', required: true, description: 'referencia tal como la escribe el usuario' }],
    ask: '¿Qué pedido? Dime su referencia (por ejemplo ORD-CB07203E).',
    fromArgs(args) {
      const ref = argText(args.reference, 40)
      // Una referencia tiene números y solo letras, números y guiones ("mi pedido" no lo es).
      if (!ref || !/\d/.test(ref) || !/^[a-z0-9-]{4,40}$/i.test(ref)) return { missing: ['reference'] }
      return { input: { term: ref.toLowerCase() } }
    },
  },
  async run(ctx, input) {
    const rows = await ctx.deps.orders.findByReference(input.term.toUpperCase(), 3)
    if (rows.length === 0) {
      return result(
        `No encontré ningún pedido con la referencia «${input.term.toUpperCase()}». Usa la referencia que ve el cliente (por ejemplo ORD-CB07203E) o el número interno completo.`,
        0,
      )
    }
    if (rows.length === 1) {
      const o = rows[0]!
      return result(
        [
          `Pedido ${o.reference ?? o.orderNumber ?? '—'} (${formatDay(o.createdAt)}):`,
          `- Estado: ${statusLabel(o.status)}`,
          `- Pago: ${o.paymentStatus ?? '—'}`,
          `- Entrega: ${o.fulfillmentStatus ?? '—'}`,
          `- Artículos: ${o.itemCount}`,
          `- Total: ${formatMoney(o.total)}`,
        ].join('\n'),
        1,
        { kind: 'order', label: o.reference ?? o.orderNumber ?? input.term.toUpperCase() },
      )
    }
    return result([`Encontré ${rows.length} pedidos que empiezan por «${input.term.toUpperCase()}»:`, ...rows.map((r, i) => orderLine(r, i))].join('\n'), rows.length)
  },
}

const ordersCount: LumiTool<{ statuses: string[] | null; range: TimeRange | null }> = {
  name: 'orders.count',
  capabilityKey: 'tool-orders-count',
  enabledByDefault: true,
  label: 'Contando pedidos',
  capability: 'Contar pedidos por estado (pendientes, por despachar, enviados…) y por periodo',
  example: '¿Cuántos pedidos tengo por despachar?',
  permission: PERMISSION_REGISTRY.ORDERS_READ,
  match(text, _original, ctx) {
    if (!ORDERS_WORD.test(text)) return null
    const range = parseTimeRange(text, ctx.now, ctx.timezone)
    const status = ORDER_STATUS_WORDS.find(([re]) => re.test(text))
    // "Últimos 10 pedidos" es un listado; "¿cuántos pedidos…?" o un estado es un conteo.
    if (!COUNT_WORD.test(text) && !status) return null
    if (!COUNT_WORD.test(text) && RECENT_WORD.test(text) && !range) return null
    return { statuses: status ? status[1] : null, range }
  },
  selector: {
    description: 'Contar pedidos por estado o periodo',
    module: 'pedidos',
    args: [
      { name: 'status', kind: STATUS_VALUES },
      { name: 'period', kind: PERIOD_VALUES },
    ],
    // Estado y periodo salen del mensaje (reglas), no del modelo: así "este mes" nunca se convierte en "el mes pasado".
    fromArgs(_args, text, ctx) {
      const status = ORDER_STATUS_WORDS.find(([re]) => re.test(text))
      return { input: { statuses: status ? status[1] : null, range: parseTimeRange(text, ctx.now, ctx.timezone) } }
    },
  },
  async run(ctx, input) {
    const counts = await ctx.deps.orders.countByStatus(input.range ? { from: input.range.from, to: input.range.to } : undefined)
    const when = input.range ? ` creados ${input.range.label}` : ''
    if (input.statuses) {
      const lines = input.statuses.map((s) => `- ${statusLabel(s)}: ${counts[s] ?? 0}`)
      const total = input.statuses.reduce((sum, s) => sum + (counts[s] ?? 0), 0)
      const head =
        input.statuses.length === 1
          ? `Pedidos ${statusLabel(input.statuses[0]!)}${when}: ${total}.`
          : `Pedidos abiertos${when}: ${total}.`
      return result(input.statuses.length === 1 ? head : [head, ...lines].join('\n'), 1)
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0)
    const order = ['pending', 'paid', 'shipped', 'delivered', 'cancelled', 'expired']
    const known = order.filter((s) => counts[s]).map((s) => `- ${statusLabel(s)}: ${counts[s]}`)
    const other = Object.keys(counts)
      .filter((s) => !order.includes(s))
      .map((s) => `- ${s}: ${counts[s]}`)
    return result([`Pedidos${when || ' en total'}: ${total}.`, ...known, ...other].join('\n'), 1)
  },
}

const ordersRecent: LumiTool<{ limit: number; customerFilter: boolean }> = {
  name: 'orders.recent',
  capabilityKey: 'tool-orders-recent',
  enabledByDefault: true,
  label: 'Consultando los últimos pedidos',
  capability: 'Listar los últimos pedidos (sin datos de clientes)',
  example: 'Muéstrame los últimos 5 pedidos',
  permission: PERMISSION_REGISTRY.ORDERS_READ,
  match(text) {
    if (!ORDERS_WORD.test(text) || !RECENT_WORD.test(text) || COUNT_WORD.test(text)) return null
    if (/\bultim[oa]s? \d{1,3} dias?\b/.test(text)) return null // es un periodo, no un listado
    const count = /\b(\d{1,2})\b/.exec(text)
    const limit = Math.min(Math.max(count ? Number(count[1]) : 10, 1), 50)
    // "los últimos pedidos de Ana": no se filtra por cliente (sin datos personales). Se avisa.
    const customerFilter = /\bpedidos? (de|del cliente|de la cliente) (?!hoy|ayer|esta|este|la semana|el mes|los ultimos)[a-z]/.test(text)
    return { limit, customerFilter }
  },
  selector: {
    description: 'Listar los últimos pedidos',
    module: 'pedidos',
    args: [{ name: 'limit', kind: 'int' }],
    fromArgs(_args, text) {
      const count = /\b(\d{1,2})\b/.exec(text)
      return { input: { limit: Math.min(Math.max(count ? Number(count[1]) : 10, 1), 50), customerFilter: false } }
    },
  },
  async run(ctx, input) {
    const rows = await ctx.deps.orders.recent(input.limit)
    const note = input.customerFilter ? '\n\nNota: no filtro pedidos por cliente; esta es la lista general.' : ''
    if (rows.length === 0) return result(`No hay pedidos registrados.${note}`, 0)
    const head = rows.length < input.limit ? `Pedidos (${rows.length}):` : `Últimos ${rows.length} pedidos:`
    return result([head, ...rows.map((r, i) => orderLine(r, i))].join('\n') + note, rows.length)
  },
}

const salesSummary: LumiTool<{ range: TimeRange; top: boolean }> = {
  name: 'sales.summary',
  capabilityKey: 'tool-sales-summary',
  enabledByDefault: true,
  label: 'Calculando ventas',
  capability: 'Ventas, pedidos vendidos y ticket promedio de un periodo (hoy, ayer, esta semana, este mes, últimos N días)',
  example: '¿Cuánto vendimos esta semana?',
  permission: PERMISSION_REGISTRY.ANALYTICS_READ,
  match(text, _original, ctx) {
    if (!SALES_WORD.test(text) && !TOP_SELLERS.test(text)) return null
    if (ORDERS_WORD.test(text) && COUNT_WORD.test(text) && !SALES_WORD.test(text)) return null
    return {
      range: parseTimeRange(text, ctx.now, ctx.timezone) ?? todayRange(ctx.now, ctx.timezone),
      top: TOP_SELLERS.test(text),
    }
  },
  selector: {
    description: 'Ventas, ticket promedio y más vendidos de un periodo',
    module: 'ventas',
    args: [
      { name: 'period', kind: PERIOD_VALUES, required: true },
      { name: 'compare_to', kind: ['previous_period'], description: 'si pide comparar con el periodo anterior' },
    ],
    fromArgs(_args, text, ctx) {
      return {
        input: {
          range: parseTimeRange(text, ctx.now, ctx.timezone) ?? todayRange(ctx.now, ctx.timezone),
          top: TOP_SELLERS.test(text),
        },
      }
    },
  },
  async run(ctx, input) {
    const s = await ctx.deps.orders.salesSummary(input.range.from, input.range.to)
    const aov = s.soldOrders > 0 ? s.revenue / s.soldOrders : 0
    const lines = [
      `Ventas de ${input.range.label}: ${formatMoney(s.revenue)} en ${s.soldOrders} ${s.soldOrders === 1 ? 'pedido vendido' : 'pedidos vendidos'} (pagados, enviados o entregados).`,
      `- Ticket promedio: ${formatMoney(aov)}`,
      `- Pedidos creados en el periodo (cualquier estado): ${s.orders}`,
    ]
    if (s.refunds > 0) lines.push(`- Reembolsos: ${formatMoney(s.refunds)}`)
    if (input.top || s.topProducts.length > 0) {
      const top = s.topProducts.slice(0, 5)
      if (top.length > 0) {
        lines.push('Más vendidos:', ...top.map((p, i) => `${i + 1}. ${p.name}: ${p.units} uds · ${formatMoney(p.revenue)}`))
      } else if (input.top) {
        lines.push('No hay productos vendidos en ese periodo.')
      }
    }
    return result(lines.join('\n'), 1)
  },
}

const productsSearch: LumiTool<{ term: string }> = {
  name: 'products.search',
  capabilityKey: 'tool-products-search',
  enabledByDefault: true,
  label: 'Buscando productos',
  capability: 'Buscar un producto y ver su precio (y su stock si puedes ver el inventario)',
  example: '¿Cuánto stock queda de la vela de vainilla?',
  permission: PERMISSION_REGISTRY.PRODUCTS_READ,
  match(text) {
    if (INVENTORY_WORD.test(text) && !/\b(de|del) /.test(text.replace(INVENTORY_WORD, ''))) return null
    for (const pattern of PRODUCT_PATTERNS) {
      const m = pattern.exec(text)
      if (!m) continue
      const term = cleanTerm(m[1]!)
      // "stock de productos" o "precio de todo" no nombran un producto concreto.
      if (term && !/^(todo|todos|todas|productos?|inventario|la tienda)$/.test(term)) return { term }
    }
    return null
  },
  selector: {
    description: 'Buscar productos por nombre y ver su precio y su stock',
    module: 'productos',
    args: [{ name: 'query', kind: 'str', required: true, description: "texto a buscar, sin palabras como 'busca' o 'producto'" }],
    ask: '¿Qué producto busco? Dime su nombre o una palabra del nombre.',
    fromArgs(args) {
      const raw = argText(args.query)
      const term = raw ? cleanTerm(normalizeText(raw)) : null
      if (!term || /^(todo|todos|todas|productos?|inventario|la tienda)$/.test(term)) return { missing: ['query'] }
      return { input: { term } }
    },
  },
  async run(ctx, input) {
    const rows = await ctx.deps.products.search(input.term, 8)
    if (rows.length === 0) return result(`No encontré productos que coincidan con «${input.term}».`, 0)
    const canSeeStock = hasPermission([...ctx.permissionKeys], PERMISSION_REGISTRY.INVENTORY_READ)
    const lines = rows.map((p) => {
      const price =
        p.minPrice === null ? 'sin precio' : p.maxPrice !== null && p.maxPrice !== p.minPrice ? `${formatMoney(p.minPrice)}–${formatMoney(p.maxPrice)}` : formatMoney(p.minPrice)
      const state = p.status === 'inactive' ? ' (inactivo)' : p.status === 'draft' ? ' (borrador)' : ''
      // Las existencias son del módulo de inventario: solo se muestran con inventory.read.
      const stock = canSeeStock ? `${Math.max(0, p.available)} disponibles · ` : ''
      return `- ${p.name}${state}: ${stock}${price}`
    })
    const only = rows.length === 1 ? { kind: 'product' as const, label: rows[0]!.name } : undefined
    return result([`Productos que coinciden con «${input.term}»:`, ...lines].join('\n'), rows.length, only)
  },
}

export const LOW_STOCK_THRESHOLD = 3

const inventoryLow: LumiTool<Record<string, never>> = {
  name: 'inventory.low',
  capabilityKey: 'tool-inventory-low',
  enabledByDefault: true,
  label: 'Revisando el inventario',
  capability: `Productos sin stock o con stock bajo (${LOW_STOCK_THRESHOLD} unidades o menos)`,
  example: '¿Qué productos se están agotando?',
  permission: PERMISSION_REGISTRY.INVENTORY_READ,
  match(text) {
    return INVENTORY_WORD.test(text) ? {} : null
  },
  selector: {
    description: 'Productos agotados, sin stock, con poco stock o por reponer',
    module: 'inventario',
    args: [],
    fromArgs: () => ({ input: {} }),
  },
  async run(ctx) {
    const rows = await ctx.deps.products.lowStock(LOW_STOCK_THRESHOLD, 15)
    if (rows.length === 0) return result(`No hay productos activos con ${LOW_STOCK_THRESHOLD} unidades o menos.`, 0)
    const out = rows.filter((r) => r.available <= 0)
    const low = rows.filter((r) => r.available > 0)
    const lines: string[] = []
    if (out.length) lines.push(`Sin stock (${out.length}):`, ...out.map((r) => `- ${r.name}`))
    if (low.length) lines.push(`Stock bajo (${low.length}):`, ...low.map((r) => `- ${r.name}: ${r.available} disponibles`))
    if (rows.length >= 15) lines.push('(Se muestran los 15 más urgentes.)')
    return result(lines.join('\n'), rows.length)
  },
}

const PRIORITY_LABEL: Record<number, string> = { 3: 'urgente', 2: 'revisar', 1: 'informativa' }

const initiativesList: LumiTool<{ urgentOnly: boolean }> = {
  name: 'initiatives.list',
  capabilityKey: 'tool-initiatives-list',
  enabledByDefault: true,
  label: 'Revisando tus iniciativas',
  capability: 'Ver tus iniciativas abiertas (stock, pedidos atrasados, recordatorios fallidos)',
  example: '¿Qué iniciativas urgentes tengo?',
  permission: null,
  match(text) {
    if (!INITIATIVES_WORD.test(text) || !LISTING_HINT.test(text)) return null
    return { urgentOnly: /\burgentes?\b/.test(text) }
  },
  selector: {
    description: 'Iniciativas abiertas de Lumi',
    module: 'iniciativas',
    args: [{ name: 'urgent_only', kind: 'bool' }],
    fromArgs: (args, text) => ({ input: { urgentOnly: args.urgent_only === true || /\burgentes?\b/.test(text) } }),
  },
  async run(ctx, input) {
    const all = await ctx.deps.initiatives.list(ctx.userId, ctx.permissionKeys, 100)
    const open = all.filter((i) => ['nueva', 'pendiente', 'en_revision', 'aceptada'].includes(i.state))
    const shown = input.urgentOnly ? open.filter((i) => i.priority === 3) : open
    if (shown.length === 0) {
      return result(input.urgentOnly ? 'No tienes iniciativas urgentes abiertas.' : 'No tienes iniciativas abiertas.', 0)
    }
    const urgent = open.filter((i) => i.priority === 3).length
    const head = input.urgentOnly
      ? `Tienes ${shown.length} ${shown.length === 1 ? 'iniciativa urgente' : 'iniciativas urgentes'}:`
      : `Tienes ${open.length} ${open.length === 1 ? 'iniciativa abierta' : 'iniciativas abiertas'} (${urgent} urgentes):`
    const lines = shown.slice(0, 15).map((i) => `- [${PRIORITY_LABEL[i.priority] ?? i.priority}] ${i.title}: ${i.detail}`)
    if (shown.length > 15) lines.push(`(y ${shown.length - 15} más en la página Iniciativas)`)
    return result([head, ...lines].join('\n'), shown.length)
  },
}

const notificationsUnread: LumiTool<Record<string, never>> = {
  name: 'notifications.unread',
  capabilityKey: 'tool-notifications-unread',
  enabledByDefault: true,
  label: 'Revisando tus notificaciones',
  capability: 'Contar y listar tus notificaciones sin leer',
  example: '¿Tengo notificaciones sin leer?',
  permission: null,
  match(text) {
    return NOTIFICATIONS_WORD.test(text) && LISTING_HINT.test(text) ? {} : null
  },
  selector: {
    description: 'Notificaciones sin leer',
    module: 'notificaciones',
    args: [],
    fromArgs: () => ({ input: {} }),
  },
  async run(ctx) {
    const [count, recent] = await Promise.all([
      ctx.deps.notifications.countUnread(ctx.userId),
      ctx.deps.notifications.recentUnread(ctx.userId, 5),
    ])
    if (count === 0) return result('No tienes notificaciones sin leer.', 0)
    const lines = recent.map((n) => `- ${formatDay(n.createdAt)} · ${n.title}`)
    const more = count > recent.length ? `\n(y ${count - recent.length} más en el centro de notificaciones)` : ''
    return result([`Tienes ${count} ${count === 1 ? 'notificación sin leer' : 'notificaciones sin leer'}:`, ...lines].join('\n') + more, count)
  },
}

/**
 * Orden de evaluación: lo más específico primero (una referencia concreta, un conteo) y los listados
 * generales al final. La primera herramienta que reconoce el mensaje lo resuelve.
 */
export const LUMI_TOOLS: ReadonlyArray<LumiTool<never>> = [
  ordersLookup,
  ordersCount,
  ordersRecent,
  salesSummary,
  // Antes de la búsqueda: «productos sin precio» no es buscar el texto «sin precio».
  productsUnpriced,
  productsSearch,
  inventoryLow,
  initiativesList,
  notificationsUnread,
] as unknown as ReadonlyArray<LumiTool<never>>

export interface ToolMatch {
  tool: LumiTool<never>
  input: never
  /** El usuario no tiene el permiso: se responde sin leer datos. */
  denied: boolean
  /** Además de los datos, pide una explicación: los datos van al modelo como contexto. */
  explain: boolean
}

/** Herramientas habilitadas (fase E). Sin conjunto (pruebas, código previo): todas. */
export type EnabledTools = ReadonlySet<string> | undefined

export function isToolEnabled(tool: Pick<LumiTool<never>, 'name'>, enabled: EnabledTools): boolean {
  return enabled === undefined || enabled.has(tool.name)
}

export function canUseTool(tool: Pick<LumiTool<never>, 'permission'>, keys: readonly PermissionId[]): boolean {
  return tool.permission === null || hasPermission([...keys], tool.permission)
}

/** Primera herramienta que reconoce el mensaje, con el resultado de la comprobación de permisos. */
export function matchTool(
  message: string,
  keys: readonly PermissionId[],
  ctx: { now: Date; timezone: string; enabled?: EnabledTools },
): ToolMatch | null {
  const normalized = normalizeText(message)
  for (const tool of LUMI_TOOLS) {
    // Una herramienta deshabilitada no existe para el chat (fase E).
    if (!isToolEnabled(tool, ctx.enabled)) continue
    const input = tool.match(normalized, message, ctx)
    if (input === null) continue
    return { tool, input, denied: !canUseTool(tool, keys), explain: wantsExplanation(normalized) }
  }
  return null
}

const DENIED_TEXT: Record<string, string> = {
  [PERMISSION_REGISTRY.ORDERS_READ]: 'No tienes permiso para consultar pedidos.',
  [PERMISSION_REGISTRY.PRODUCTS_READ]: 'No tienes permiso para consultar productos.',
  [PERMISSION_REGISTRY.INVENTORY_READ]: 'No tienes permiso para consultar el inventario.',
  [PERMISSION_REGISTRY.ANALYTICS_READ]: 'No tienes permiso para consultar ventas ni analítica.',
}

/** Ejecuta la herramienta. Sin permiso no se lee nada: se devuelve el aviso. */
export async function runTool(match: ToolMatch, ctx: LumiToolContext): Promise<LumiToolResult> {
  if (match.denied) {
    const permission = match.tool.permission
    return { text: (permission && DENIED_TEXT[permission]) || 'No tienes permiso para esa consulta.', rows: 0 }
  }
  return match.tool.run(ctx, match.input)
}

/**
 * Texto de capacidades para el modelo: lo que este usuario puede pedir (según sus permisos) y cómo.
 * Se envía en cada turno que llega al modelo. Lo escribe el Server; no contiene datos de la tienda.
 */
export function capabilitiesFor(
  keys: readonly PermissionId[],
  now: Date,
  timezone: string,
  enabled?: EnabledTools,
): string {
  const today = new Intl.DateTimeFormat('es-CO', {
    timeZone: timezone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(now)
  const tools = LUMI_TOOLS.filter((t) => isToolEnabled(t, enabled) && canUseTool(t, keys)).map((t) => `- ${t.capability}. Ejemplo: «${t.example}»`)
  return [
    `Hoy es ${today} (hora de ${timezone}). Eres Lumi, el asistente del panel de administración de la tienda Lumia.`,
    'El sistema (no tú) puede hacer esto cuando el usuario lo pide con frases como las de ejemplo:',
    ...tools,
    '- Recordatorios con fecha y hora y rutinas diarias. Ejemplo: «Recuérdame mañana a las 9 de la mañana llamar al proveedor»',
    'Reglas: tú no ejecutas acciones ni consultas datos. Nunca digas que creaste, programaste, cambiaste o borraste algo, ni inventes cifras de la tienda.',
    'Si el usuario pide algo de esa lista, indícale la frase de ejemplo para que el sistema lo haga. Si pide algo que no está en la lista, di que todavía no está disponible.',
  ].join('\n')
}

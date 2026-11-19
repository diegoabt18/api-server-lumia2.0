import { z } from 'zod'

/**
 * Contexto de pantalla para Lumi. El navegador solo indica DÓNDE está el administrador (tipo de
 * vista e identificador). El servidor decide QUÉ datos se leen, con el permiso del usuario, y
 * envía solo un resumen en lista blanca: sin datos de clientes ni texto libre del navegador.
 */

export const LUMI_PAGES = [
  'dashboard',
  'analytics',
  'inventory',
  'settings',
  'products',
  'orders',
  'categories',
  'subcategories',
  'promotions',
  'banners',
  'images',
  'reviews',
  'production',
  'automations',
  'initiatives',
] as const
export type LumiPage = (typeof LUMI_PAGES)[number]

const objectId = z.string().regex(/^[a-f0-9]{24}$/i)

export const lumiContextInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('product'), id: objectId }),
  z.object({ kind: z.literal('order'), id: objectId }),
  z.object({ kind: z.literal('page'), page: z.enum(LUMI_PAGES) }),
])
export type LumiContextInput = z.infer<typeof lumiContextInputSchema>

export const LUMI_PAGE_LABELS: Record<LumiPage, string> = {
  dashboard: 'Dashboard',
  analytics: 'Analítica',
  inventory: 'Inventario',
  settings: 'Configuración de la tienda',
  products: 'Productos',
  orders: 'Pedidos',
  categories: 'Categorías',
  subcategories: 'Subcategorías',
  promotions: 'Promociones',
  banners: 'Banners',
  images: 'Imágenes',
  reviews: 'Reseñas y preguntas',
  production: 'Producción y costeo',
  automations: 'Automatizaciones de Lumi',
  initiatives: 'Iniciativas de Lumi',
}

/**
 * Qué se hace en las vistas que no envían datos (o cuando falta el permiso del módulo).
 * Texto fijo del sistema: nunca datos de la tienda.
 */
const LUMI_PAGE_DESCRIPTIONS: Partial<Record<LumiPage, string>> = {
  images: 'Herramienta para subir y optimizar imágenes de productos y materiales.',
  reviews:
    'Moderación de reseñas y preguntas de clientes: ocultar, destacar o marcar como respondidas.',
  automations: 'Tareas y rutinas programadas de Lumi del administrador.',
  initiatives: 'Sugerencias proactivas de Lumi sobre la tienda, con su estado.',
  settings: 'Ajustes de envío, moneda, clientes y pagos de la tienda.',
}

/** Límite del texto de contexto (el asistente acepta hasta 2000 caracteres). */
export const LUMI_CONTEXT_MAX_CHARS = 1800
const FIELD_MAX_CHARS = 300

/** Forma mínima que usa el resumen. Solo campos que el panel ya muestra al administrador. */
export interface ProductContextSource {
  product: {
    name: string
    slug: string
    status: string
    categorySlug: string | null
    brand: string | null
    description: string | null
  }
  variants: ReadonlyArray<{
    sku: string
    price: number
    currency: string
    stock: number
    reserved: number
  }>
}

/** Pedido sin datos del cliente: estado, importes y artículos. */
export interface OrderContextSource {
  order: {
    orderNumber: string | null
    status: string
    paymentStatus: string | null
    fulfillmentStatus: string | null
    paymentMethod: string | null
    currency: string
    total: number
    subtotal: number
    items?: ReadonlyArray<{ name: string; quantity: number }>
  }
}

function clip(value: string | null | undefined, max = FIELD_MAX_CHARS): string {
  if (value === null || value === undefined) return '—'
  const text = value.replace(/\s+/g, ' ').trim()
  if (!text) return '—'
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function limit(text: string): string {
  return text.length > LUMI_CONTEXT_MAX_CHARS
    ? `${text.slice(0, LUMI_CONTEXT_MAX_CHARS - 1)}…`
    : text
}

export function summarizePageContext(page: LumiPage): string {
  const description = LUMI_PAGE_DESCRIPTIONS[page]
  return description
    ? `Vista actual: ${LUMI_PAGE_LABELS[page]}.\n${description}`
    : `Vista actual: ${LUMI_PAGE_LABELS[page]}.`
}

/** Filas que se listan en los resúmenes de vistas de listado (el resto solo se cuenta). */
const LIST_ROWS = 15

function statusText(status: string | null | undefined): string {
  if (status === 'active') return 'activa'
  if (status === 'inactive') return 'inactiva'
  return clip(status ?? null, 20)
}

function listHeader(page: LumiPage, shown: number, total: number): string {
  const more = total > shown ? ` (se listan ${shown} de ${total})` : ''
  return `Vista actual: ${LUMI_PAGE_LABELS[page]}. Total: ${total}${more}.`
}

/** Listado de productos: nombre, estado y ubicación en el catálogo. */
export interface ProductListContextSource {
  products: ReadonlyArray<{
    name: string
    status: string | null
    categoryName: string | null
    subcategoryName: string | null
  }>
  total: number
}

export function summarizeProductListContext(source: ProductListContextSource): string {
  const rows = source.products.slice(0, LIST_ROWS)
  const lines = [
    listHeader('products', rows.length, source.total),
    'Productos más recientes (estado; categoría / subcategoría):',
    ...rows.map(
      (p) =>
        `- ${clip(p.name, 100)}: ${statusText(p.status)}; ${clip(p.categoryName, 60)} / ${clip(p.subcategoryName, 60)}`,
    ),
  ]
  return limit(lines.join('\n'))
}

/** Inventario por SKU: cantidades, sin datos de pedidos ni clientes. */
export interface InventoryContextSource {
  items: ReadonlyArray<{
    sku: string
    available: number
    quantity: number
    isPerOrder: boolean
    variantName: string | null
  }>
  total: number
}

export function summarizeInventoryContext(source: InventoryContextSource): string {
  const rows = source.items.slice(0, LIST_ROWS)
  const lines = [
    listHeader('inventory', rows.length, source.total),
    'SKU actualizados recientemente (disponible / existencias):',
    ...rows.map(
      (i) =>
        `- ${clip(i.sku, 40)} ${clip(i.variantName, 80)}: ${i.isPerOrder ? 'bajo pedido' : `${i.available} / ${i.quantity}`}`,
    ),
  ]
  return limit(lines.join('\n'))
}

export interface CategoryContextSource {
  categories: ReadonlyArray<{
    name: string
    status: string
    subcategoryCount: number
    activeSubcategoryCount: number
    productCount: number
    unclassifiedProductCount: number
  }>
  total: number
}

export function summarizeCategoriesContext(source: CategoryContextSource): string {
  const rows = source.categories.slice(0, LIST_ROWS)
  const lines = [
    listHeader('categories', rows.length, source.total),
    'Categorías (estado; subcategorías activas/total; productos):',
    ...rows.map((c) => {
      const unclassified =
        c.unclassifiedProductCount > 0 ? `, ${c.unclassifiedProductCount} sin subcategoría` : ''
      return `- ${clip(c.name, 80)}: ${statusText(c.status)}; subcategorías ${c.activeSubcategoryCount}/${c.subcategoryCount}; productos ${c.productCount}${unclassified}`
    }),
  ]
  return limit(lines.join('\n'))
}

export interface SubcategoryContextSource {
  subcategories: ReadonlyArray<{
    name: string
    status: string
    categoryName: string
    productCount: number
  }>
  total: number
}

export function summarizeSubcategoriesContext(source: SubcategoryContextSource): string {
  const rows = source.subcategories.slice(0, LIST_ROWS)
  const lines = [
    listHeader('subcategories', rows.length, source.total),
    'Subcategorías (categoría; estado; productos):',
    ...rows.map(
      (s) =>
        `- ${clip(s.name, 80)} (${clip(s.categoryName, 60)}): ${statusText(s.status)}; productos ${s.productCount}`,
    ),
  ]
  return limit(lines.join('\n'))
}

const PROMOTION_LIFECYCLE_LABELS: Record<string, string> = {
  pendiente: 'programada',
  activa: 'vigente',
  finalizada: 'finalizada',
}

export interface PromotionContextSource {
  promotions: ReadonlyArray<{
    name: string
    active: boolean
    lifecycle: string
    startsAt: string
    endsAt: string
    applyGeneralDiscount: boolean
    generalPercentOff: number | null
    categorySlugs: ReadonlyArray<string>
    productEntries: ReadonlyArray<unknown>
  }>
  total: number
}

export function summarizePromotionsContext(source: PromotionContextSource): string {
  const rows = source.promotions.slice(0, LIST_ROWS)
  const lines = [
    listHeader('promotions', rows.length, source.total),
    'Promociones (estado; vigencia; alcance):',
    ...rows.map((p) => {
      const state = p.active
        ? (PROMOTION_LIFECYCLE_LABELS[p.lifecycle] ?? clip(p.lifecycle, 20))
        : 'desactivada'
      const scope = [
        p.applyGeneralDiscount && p.generalPercentOff !== null
          ? `${p.generalPercentOff}% general`
          : null,
        p.categorySlugs.length ? `${p.categorySlugs.length} categorías` : null,
        p.productEntries.length ? `${p.productEntries.length} productos` : null,
      ]
        .filter(Boolean)
        .join(', ')
      return `- ${clip(p.name, 80)}: ${state}; ${p.startsAt.slice(0, 10)} a ${p.endsAt.slice(0, 10)}; ${scope || 'sin alcance'}`
    }),
  ]
  return limit(lines.join('\n'))
}

export interface BannerContextSource {
  banners: ReadonlyArray<{
    title: string | null
    position: string
    active: boolean
    startsAt: string
    endsAt: string
  }>
}

export function summarizeBannersContext(
  source: BannerContextSource,
  now: Date = new Date(),
): string {
  const rows = source.banners.slice(0, LIST_ROWS)
  const nowMs = now.getTime()
  const lines = [
    listHeader('banners', rows.length, source.banners.length),
    'Banners (posición; estado; vigencia):',
    ...rows.map((b) => {
      const state = !b.active
        ? 'desactivado'
        : Date.parse(b.endsAt) < nowMs
          ? 'vencido'
          : Date.parse(b.startsAt) > nowMs
            ? 'programado'
            : 'visible'
      return `- ${clip(b.title, 80)} (${clip(b.position, 30)}): ${state}; ${b.startsAt.slice(0, 10)} a ${b.endsAt.slice(0, 10)}`
    }),
  ]
  return limit(lines.join('\n'))
}

/** Cifras del tablero de producción (mismo origen que el dashboard de producción). */
export interface ProductionContextSource {
  totalMaterials: number
  activeMaterials: number
  totalSuppliers: number
  totalRecipes: number
  productsWithOutdatedCosts: number
  averageCost: number
  minCost: number
  maxCost: number
  weeklyCostChanges: ReadonlyArray<{ materialName: string; prevCost: number; newCost: number }>
}

export function summarizeProductionContext(source: ProductionContextSource): string {
  const lines = [
    `Vista actual: ${LUMI_PAGE_LABELS.production}. Importes en la moneda de la tienda.`,
    `Materiales: ${source.totalMaterials} (activos ${source.activeMaterials}). Proveedores activos: ${source.totalSuppliers}. Recetas: ${source.totalRecipes}.`,
    `Productos con costos desactualizados: ${source.productsWithOutdatedCosts}.`,
    `Costo de recetas activas: promedio ${source.averageCost}, mínimo ${source.minCost}, máximo ${source.maxCost}.`,
    `Cambios de costo de materiales en los últimos 7 días: ${source.weeklyCostChanges.length}.`,
    ...source.weeklyCostChanges
      .slice(0, 8)
      .map((c) => `- ${clip(c.materialName, 80)}: ${c.prevCost} → ${c.newCost}`),
  ]
  return limit(lines.join('\n'))
}

export function summarizeProductContext(source: ProductContextSource): string {
  const p = source.product
  const lines = [
    `Producto: ${clip(p.name)}`,
    `Estado: ${clip(p.status, 40)}`,
    `Categoría: ${clip(p.categorySlug, 80)}`,
    `Marca: ${clip(p.brand, 80)}`,
    `Descripción actual: ${clip(p.description)}`,
    `Variantes: ${source.variants.length}`,
    ...source.variants
      .slice(0, 10)
      .map(
        (v) =>
          `- SKU ${clip(v.sku, 40)}: precio ${v.price} ${clip(v.currency, 8)}, disponible ${Math.max(0, v.stock - v.reserved)}`,
      ),
  ]
  return limit(lines.join('\n'))
}

export function summarizeOrderContext(source: OrderContextSource): string {
  const o = source.order
  const items = (o.items ?? []).slice(0, 15)
  const lines = [
    `Pedido: ${clip(o.orderNumber, 60)}`,
    `Estado: ${clip(o.status, 40)}; pago: ${clip(o.paymentStatus, 40)}; entrega: ${clip(o.fulfillmentStatus, 40)}`,
    `Método de pago: ${clip(o.paymentMethod, 60)}`,
    `Total: ${o.total} ${clip(o.currency, 8)} (subtotal ${o.subtotal})`,
    `Artículos (${o.items?.length ?? 0}):`,
    ...items.map((item) => `- ${clip(item.name, 120)} x${item.quantity}`),
  ]
  return limit(lines.join('\n'))
}

/** Cifras agregadas del Dashboard (mismo origen que /admin/dashboard/stats). Sin datos de clientes. */
export interface DashboardContextSource {
  productCount: number
  activeProductCount: number
  orderCount: number
  totalSales: number
  activePromotions: number
  top: { selling: ReadonlyArray<{ name?: string | null }> }
  alerts: {
    promotionsExpiringSoon: ReadonlyArray<unknown>
    outOfStockProducts: ReadonlyArray<unknown>
    emptyCategories: ReadonlyArray<unknown>
  }
}

export function summarizeDashboardContext(source: DashboardContextSource): string {
  const lines = [
    `Vista actual: ${LUMI_PAGE_LABELS.dashboard}.`,
    `Productos: ${source.productCount} (activos ${source.activeProductCount}).`,
    `Pedidos: ${source.orderCount}. Ventas pagadas: ${Math.round(source.totalSales)}.`,
    `Promociones activas: ${source.activePromotions}.`,
    `Alertas (listas de hasta 8): sin stock ${source.alerts.outOfStockProducts.length}, promociones por vencer ${source.alerts.promotionsExpiringSoon.length}, categorías vacías ${source.alerts.emptyCategories.length}.`,
    'Más vendidos:',
    ...source.top.selling.slice(0, 5).map((p, i) => `${i + 1}. ${clip(p.name ?? null, 120)}`),
  ]
  return limit(lines.join('\n'))
}

/** Resumen de Analítica: cifras del periodo y comparación con el anterior. Sin datos de clientes. */
export interface AnalyticsContextSource {
  period: { label: string }
  revenue: { current: number; growth: number | null }
  orders: { current: number; growth: number | null }
  aov: { current: number; growth: number | null }
  newCustomers: { current: number; growth: number | null }
  topProducts: ReadonlyArray<{ name: string; units: number; revenue: number }>
}

const ANALYTICS_PERIOD_LABELS: Record<string, string> = {
  '7d': 'últimos 7 días',
  '30d': 'últimos 30 días',
  '90d': 'últimos 90 días',
  '1y': 'último año',
}

function growthText(growth: number | null): string {
  if (growth === null) return 'sin base de comparación'
  return `${growth >= 0 ? '+' : ''}${growth}% vs periodo anterior`
}

export function summarizeAnalyticsContext(source: AnalyticsContextSource): string {
  const period = ANALYTICS_PERIOD_LABELS[source.period.label] ?? clip(source.period.label, 40)
  const lines = [
    `Vista actual: ${LUMI_PAGE_LABELS.analytics} (${period}). Importes en la moneda de la tienda.`,
    `Ingresos: ${source.revenue.current} (${growthText(source.revenue.growth)}).`,
    `Pedidos: ${source.orders.current} (${growthText(source.orders.growth)}).`,
    `Ticket promedio: ${source.aov.current} (${growthText(source.aov.growth)}).`,
    `Clientes nuevos: ${source.newCustomers.current} (${growthText(source.newCustomers.growth)}).`,
    'Productos con más ingresos:',
    ...source.topProducts
      .slice(0, 5)
      .map((p, i) => `${i + 1}. ${clip(p.name, 120)}: ${p.units} uds, ${p.revenue}`),
  ]
  return limit(lines.join('\n'))
}

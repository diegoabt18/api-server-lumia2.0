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
  return `Vista actual: ${LUMI_PAGE_LABELS[page]}.`
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

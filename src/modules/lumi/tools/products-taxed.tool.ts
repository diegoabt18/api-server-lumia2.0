import { PERMISSION_REGISTRY } from '../../../common/permissions/registry.js'
import { TOOL_TEXT_MAX_CHARS, type LumiTool, type LumiToolResult } from './tool.types.js'

/**
 * «Productos con IVA configurado»: productos cuyo `tax_rate` es un número (0 % incluido: es una
 * tasa configurada). Inversa de `products.untaxed`. Solo lectura.
 *
 * El IVA se define por producto, no por variante, así que no hay casos «parciales» entre variantes.
 * No se filtra por precio: tener IVA configurado no depende de tener precio.
 *
 * Implementa la capacidad detectada desde el chat («ver productos con iva»): su clave es la que
 * asignó el Capability Manager. Nace deshabilitada (sin `enabledByDefault`).
 */
const TAXED =
  /\b(?:con|tienen?|tengan)\s+(?:el\s+|un\s+)?(?:iva|impuestos?)\b|\b(?:iva|impuestos?)\s+(?:configurado|definido|asignado)s?\b/
/** Negaciones: «sin IVA», «no tienen IVA», «IVA sin configurar» son de `products.untaxed`. */
const NEGATED = /\b(?:sin|no|falta(?:n)?)\b(?:\s+\w+){0,3}?\s+(?:iva|impuestos?)\b|\b(?:iva|impuestos?)\s+(?:sin|no)\b/
/** Plural: «el precio con IVA del producto X» es una consulta de un producto, no un listado. */
const PRODUCTS = /\bproductos\b|\barticulos\b|\breferencias\b|\bcatalogo\b/
const PRICE = /\b(?:precios?|valor(?:es)?|cuestan?|cuanto)\b/
const LIMIT = 100

function formatRate(rate: number): string {
  return `${rate.toLocaleString('es-CO', { maximumFractionDigits: 2 })} %`
}

export const productsTaxed: LumiTool<Record<string, never>> = {
  name: 'products.taxed',
  capabilityKey: 'none-confi-impuesto-tieie-957b9d',
  label: 'Buscando productos con IVA',
  capability: 'Productos con IVA configurado y su tasa',
  example: '¿Qué productos tienen IVA configurado?',
  permission: PERMISSION_REGISTRY.PRODUCTS_READ,
  match(text) {
    return TAXED.test(text) && !NEGATED.test(text) && PRODUCTS.test(text) && !PRICE.test(text) ? {} : null
  },
  selector: {
    description: 'Productos que tienen IVA o impuesto configurado, con su tasa',
    module: 'productos',
    args: [],
    fromArgs: () => ({ input: {} }),
  },
  async run(ctx): Promise<LumiToolResult> {
    const { items, total } = await ctx.deps.products.taxed(LIMIT)
    if (total === 0) return { text: 'No hay productos con IVA configurado.', rows: 0 }
    const lines = items.map((p) => {
      const notes = [formatRate(p.taxRate), p.status !== 'active' ? (p.status === 'inactive' ? 'inactivo' : p.status) : null].filter(Boolean)
      return `- ${p.name} (${notes.join(', ')})`
    })
    const head = `${total} ${total === 1 ? 'producto tiene' : 'productos tienen'} el IVA configurado:`
    const more = total > items.length ? `\n(Se muestran ${items.length}.)` : ''
    const text = [head, ...lines].join('\n') + more
    return { text: text.length > TOOL_TEXT_MAX_CHARS ? `${text.slice(0, TOOL_TEXT_MAX_CHARS - 1)}…` : text, rows: total }
  },
}

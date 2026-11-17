import { PERMISSION_REGISTRY } from '../../../common/permissions/registry.js'
import { TOOL_TEXT_MAX_CHARS, type LumiTool, type LumiToolResult } from './tool.types.js'
import { compactRefs, entityRef, moduleRef } from '../references/lumi-references.js'

/**
 * «Productos sin precio» (primera capacidad del ciclo completo, fase E): productos cuyo precio de
 * venta falta o es cero en todas sus variantes. Solo lectura.
 *
 * Nace deshabilitada (sin `enabledByDefault`): un administrador la habilita en Lumia Admin cuando
 * su batería de pruebas pasa. Hasta entonces el chat no la ve.
 */
const UNPRICED = /\b(?:sin|no tienen?|falta(?:n)?)\s+(?:el\s+)?(?:precio|valor)\b|\bprecio (?:en )?(?:cero|0)\b/
const PRODUCTS = /\bproductos?\b|\barticulos?\b|\bcatalogo\b/
const LIMIT = 20

export const productsUnpriced: LumiTool<Record<string, never>> = {
  name: 'products.unpriced',
  capabilityKey: 'productos-sin-precio',
  label: 'Buscando productos sin precio',
  capability: 'Productos sin precio (ninguna variante con precio mayor que cero)',
  example: '¿Qué productos no tienen precio?',
  permission: PERMISSION_REGISTRY.PRODUCTS_READ,
  match(text) {
    return UNPRICED.test(text) && PRODUCTS.test(text) ? {} : null
  },
  selector: {
    description: 'Productos sin precio o con precio cero',
    module: 'productos',
    args: [],
    fromArgs: () => ({ input: {} }),
  },
  async run(ctx): Promise<LumiToolResult> {
    const { items, total } = await ctx.deps.products.unpriced(LIMIT)
    if (total === 0) return { text: 'Todos los productos tienen al menos una variante con precio.', rows: 0 }
    const lines = items.map((p) => {
      const notes = [p.variantCount === 0 ? 'sin variantes' : null, p.status !== 'active' ? p.status : null].filter(Boolean)
      return `- ${p.name}${notes.length ? ` (${notes.join(', ')})` : ''}`
    })
    const head = `${total} ${total === 1 ? 'producto no tiene' : 'productos no tienen'} precio:`
    const more = total > items.length ? `\n(Se muestran ${items.length}.)` : ''
    const text = [head, ...lines].join('\n') + more
    const references = compactRefs([...items.map((p) => entityRef('product', p.id, p.name)), moduleRef('products', 'Productos')])
    return { text: text.length > TOOL_TEXT_MAX_CHARS ? `${text.slice(0, TOOL_TEXT_MAX_CHARS - 1)}…` : text, rows: total, references }
  },
}

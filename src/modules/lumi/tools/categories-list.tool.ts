import { PERMISSION_REGISTRY } from '../../../common/permissions/registry.js'
import { TOOL_TEXT_MAX_CHARS, type LumiTool, type LumiToolResult } from './tool.types.js'

/**
 * «Categorías de la tienda»: todas las categorías en orden alfabético, con su número de productos
 * y la marca de las inactivas. No lista subcategorías ni productos. Solo lectura.
 *
 * Implementa la capacidad detectada desde el chat en producción («que categorias tengo»): su
 * clave es la que asignó el Capability Manager, así que al desplegar el Server enlaza esta
 * herramienta con esa ficha (sus peticiones, especificación e historial se conservan).
 *
 * Nace deshabilitada (sin `enabledByDefault`): se habilita en Lumia Admin tras pasar su batería.
 */
const CATEGORIES = /\bcategorias\b/
/** «productos de la categoría velas» es una búsqueda de productos, no la lista de categorías. */
const PRODUCTS_IN_CATEGORY = /\b(?:productos?|articulos?)\s+(?:de|en)\s+(?:la\s+)?categoria\b/
const LIMIT = 50

export const categoriesList: LumiTool<Record<string, never>> = {
  name: 'categories.list',
  capabilityKey: 'none-categ-42a0c3',
  label: 'Consultando categorías',
  capability: 'Lista de las categorías de la tienda con su número de productos',
  example: '¿Qué categorías tengo?',
  permission: PERMISSION_REGISTRY.CATEGORIES_READ,
  match(text) {
    return CATEGORIES.test(text) && !PRODUCTS_IN_CATEGORY.test(text) ? {} : null
  },
  selector: {
    description: 'Lista de todas las categorías de la tienda',
    module: 'categorias',
    args: [],
    fromArgs: () => ({ input: {} }),
  },
  async run(ctx): Promise<LumiToolResult> {
    const { items, total } = await ctx.deps.categories.list(LIMIT)
    if (total === 0) return { text: 'No hay categorías registradas.', rows: 0 }
    const lines = items.map((c) => {
      const products = `${c.productCount} ${c.productCount === 1 ? 'producto' : 'productos'}`
      return `- ${c.name} (${products}${c.status === 'inactive' ? ', inactiva' : ''})`
    })
    const head = total === 1 ? 'Tienes 1 categoría:' : `Tienes ${total} categorías:`
    const more = total > items.length ? `\n(Se muestran ${items.length}.)` : ''
    const text = [head, ...lines].join('\n') + more
    return { text: text.length > TOOL_TEXT_MAX_CHARS ? `${text.slice(0, TOOL_TEXT_MAX_CHARS - 1)}…` : text, rows: total }
  },
}

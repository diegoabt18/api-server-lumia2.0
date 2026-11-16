import { PERMISSION_REGISTRY } from '../../../common/permissions/registry.js'
import { TOOL_TEXT_MAX_CHARS, type LumiTool, type LumiToolResult } from './tool.types.js'

/**
 * «Productos sin IVA configurado»: productos cuyo `tax_rate` falta o no es un número. Un 0 % es
 * una tasa configurada y no aparece. Solo lectura.
 *
 * Implementa la capacidad detectada desde el chat en producción («ver los productos sin iva
 * configurado»): su clave es la que asignó el Capability Manager, así que al desplegar el Server
 * enlaza esta herramienta con esa ficha (sus peticiones e historial se conservan).
 *
 * Nace deshabilitada (sin `enabledByDefault`): se habilita en Lumia Admin tras pasar su batería.
 */
const UNTAXED =
  /\b(?:sin|no tienen?|falta(?:n)?|no (?:esta|estan)|no (?:tiene|tienen) (?:configurado|definido|asignado))\s+(?:el\s+)?(?:iva|impuestos?)\b|\b(?:iva|impuestos?)\s+(?:sin|no)\s+(?:configurar|configurado|definir|definido|asignar|asignado)\b/
const PRODUCTS = /\bproductos?\b|\barticulos?\b|\bcatalogo\b|\breferencias\b/
const LIMIT = 20

export const productsUntaxed: LumiTool<Record<string, never>> = {
  name: 'products.untaxed',
  capabilityKey: 'none-confi-impuesto-sin-f4ef0d',
  label: 'Buscando productos sin IVA',
  capability: 'Productos sin IVA configurado (sin tasa de impuesto definida)',
  example: '¿Qué productos no tienen IVA configurado?',
  permission: PERMISSION_REGISTRY.PRODUCTS_READ,
  match(text) {
    return UNTAXED.test(text) && PRODUCTS.test(text) ? {} : null
  },
  selector: {
    description: 'Productos sin IVA o impuesto configurado',
    module: 'productos',
    args: [],
    fromArgs: () => ({ input: {} }),
  },
  async run(ctx): Promise<LumiToolResult> {
    const { items, total } = await ctx.deps.products.untaxed(LIMIT)
    if (total === 0) return { text: 'Todos los productos tienen el IVA configurado.', rows: 0 }
    const lines = items.map((p) => `- ${p.name}${p.status !== 'active' ? ` (${p.status === 'inactive' ? 'inactivo' : p.status})` : ''}`)
    const head = `${total} ${total === 1 ? 'producto no tiene' : 'productos no tienen'} el IVA configurado:`
    const more = total > items.length ? `\n(Se muestran ${items.length}.)` : ''
    const text = [head, ...lines].join('\n') + more
    return { text: text.length > TOOL_TEXT_MAX_CHARS ? `${text.slice(0, TOOL_TEXT_MAX_CHARS - 1)}…` : text, rows: total }
  },
}

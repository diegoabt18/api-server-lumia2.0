import { PERMISSION_REGISTRY, hasPermission, type PermissionId } from '../../../common/permissions/registry.js'
import { canUseTool, explainWith, isToolEnabled, LUMI_TOOLS, type EnabledTools, type ToolMatch } from '../tools/catalog.js'
import {
  LUMI_MODULES,
  type LumiEntityRef,
  type LumiSelectorArg,
  type LumiTool,
  type LumiToolContext,
} from '../tools/tool.types.js'
import { grounded, plainText } from './selector-text.js'

/**
 * Etapa 2 del Intent Engine de Lumi. Las reglas (etapa 1) no reconocieron el mensaje: el modelo
 * PROPONE una herramienta del catálogo, que es conversación o que falta una capacidad. El Server
 * (etapa 3) valida, completa los argumentos y decide el estado final.
 *
 * Especificación medida: `local-ai-assistant/bench/rules.py` (entrenamiento, validación y control).
 */

/* ───────────────────────── Catálogo que ve el modelo ───────────────────────── */

export type LumiDelegate = 'web' | 'chat' | 'reminder'

interface DelegateSpec {
  name: string
  description: string
  module: (typeof LUMI_MODULES)[number] | null
  args: readonly LumiSelectorArg[]
  delegate: LumiDelegate
}

/**
 * Intenciones que no son herramientas de datos: las resuelve otra parte de Lumi (el chat con o sin
 * búsqueda web, o los recordatorios por reglas). Están en el catálogo para que el modelo no las
 * confunda con una capacidad que falta.
 */
const DELEGATES: readonly DelegateSpec[] = [
  {
    name: 'reminders.create',
    description: 'Crear un recordatorio o una tarea, puntual o que se repite',
    module: 'recordatorios',
    args: [
      { name: 'text', kind: 'str', required: true, description: 'qué recordar' },
      { name: 'when', kind: 'str', required: true, description: 'fecha u hora tal como las dice el usuario' },
    ],
    delegate: 'reminder',
  },
  { name: 'time.now', description: 'Fecha y hora actuales', module: null, args: [], delegate: 'chat' },
  {
    name: 'weather.get',
    description: 'Clima de un lugar',
    module: null,
    args: [
      { name: 'place', kind: 'str' },
      { name: 'day', kind: ['today', 'tomorrow'] },
    ],
    delegate: 'web',
  },
  {
    name: 'web.research',
    description: 'Buscar información actual en internet',
    module: null,
    args: [{ name: 'query', kind: 'str', required: true }],
    delegate: 'web',
  },
]

export interface SelectorToolSpec {
  name: string
  description: string
  args: Array<{ name: string; kind: string | string[]; required: boolean; description: string }>
}

const selectorTools = (enabled?: EnabledTools): Array<LumiTool<never>> =>
  LUMI_TOOLS.filter((t) => t.selector !== undefined && isToolEnabled(t, enabled))

/**
 * Catálogo para /select. Se envían TODAS las herramientas de datos, también las que el usuario no
 * puede usar: si se ocultaran, "¿cuánto vendimos?" sin permiso de analítica se registraría como una
 * capacidad que falta. El permiso se comprueba después, en el Server, y no se lee ningún dato.
 *
 * Excepción: las de un módulo externo (música) solo van si el usuario tiene su permiso, y su módulo
 * solo aparece si va alguna. Sin ellas, «pon música» es conversación, no una capacidad que falta.
 * Sin `keys` (pruebas, código previo) van todas.
 */
export function selectorCatalog(
  enabled?: EnabledTools,
  keys?: readonly PermissionId[],
  /** Solo las herramientas de estos módulos (selección en dos niveles, ver tool-groups.ts). */
  onlyModules?: ReadonlySet<string>,
  withDelegates = true,
): { tools: SelectorToolSpec[]; modules: string[] } {
  const spec = (name: string, description: string, args: readonly LumiSelectorArg[]): SelectorToolSpec => ({
    name,
    description,
    args: args.map((a) => ({
      name: a.name,
      kind: typeof a.kind === 'string' ? a.kind : [...a.kind],
      required: a.required ?? false,
      description: a.description ?? '',
    })),
  })
  const tools = selectorTools(enabled)
    .filter((t) => t.external === undefined || keys === undefined || canUseTool(t, keys))
    .filter((t) => !onlyModules || onlyModules.has(t.selector!.module))
  const externalModules = new Set(selectorTools().filter((t) => t.external).map((t) => t.selector!.module as string))
  const usedModules = new Set(tools.map((t) => t.selector!.module as string))
  return {
    tools: [
      ...tools.map((t) => spec(t.name, t.selector!.description, t.selector!.args)),
      ...(withDelegates ? DELEGATES.map((d) => spec(d.name, d.description, d.args)) : []),
    ],
    modules: LUMI_MODULES.filter(
      (m) => (!externalModules.has(m) || usedModules.has(m)) && (!onlyModules || onlyModules.has(m)),
    ),
  }
}

/* ───────────────────────── Propuesta del modelo ───────────────────────── */

export type SelectorStatus = 'tool' | 'chat' | 'missing' | 'ambiguous'

export interface SelectorProposal {
  status: SelectorStatus
  intents: Array<{ tool: string; args: Record<string, unknown> }>
  need: string
  module: string
}

/* ───────────────────────── Etapa 3: normalización ───────────────────────── */

const DEFINITION = /^(?:que es(?! lo)|que son|que significa|que quiere decir|define|definicion de)\b/
const LOW_STOCK = /\b(?:sin stock|agot\w*|poco stock|bajo stock|se (?:esta|estan) acabando|por acabarse|reponer)\b/
const ORDER_REF = /\b(ord-\d{8}-\d{6}-[0-9a-f]{8}|ord-[0-9a-f]{4,8})\b/i
const STORE_WORDS = /\b(?:ventas?|vend\w*|pedidos?|ordenes?|productos?|stock|inventario|mis|nuestr\w*|tienda|catalogo)\b/
const NEED_MAX_CHARS = 120

export interface NormalizedProposal {
  status: SelectorStatus
  intents: Array<{ tool: string; args: Record<string, unknown> }>
  need: string
  module: string
}

/**
 * Reglas del Server sobre la propuesta del modelo: descarta herramientas y argumentos que no
 * existen, exige que los textos aparezcan en el mensaje o en la entidad activa, completa la
 * referencia desde el contexto y decide el estado. No inventa herramientas.
 */
export function normalizeProposal(
  message: string,
  proposal: SelectorProposal,
  entity: LumiEntityRef | null,
): NormalizedProposal {
  const text = plainText(message)
  const specs = new Map<string, readonly LumiSelectorArg[]>([
    ...selectorTools().map((t) => [t.name, t.selector!.args] as const),
    ...DELEGATES.map((d) => [d.name, d.args] as const),
  ])
  const entityLabel = entity?.label ?? ''
  const kept: NormalizedProposal['intents'] = []

  if (!DEFINITION.test(text)) {
    for (const intent of proposal.intents) {
      const argSpecs = specs.get(intent.tool)
      if (!argSpecs || kept.some((k) => k.tool === intent.tool)) continue
      const args: Record<string, unknown> = {}
      for (const spec of argSpecs) {
        const value = intent.args[spec.name]
        if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) continue
        if (spec.kind === 'str' && spec.name !== 'reference' && spec.name !== 'when' && !grounded(value, message, entityLabel)) {
          continue
        }
        args[spec.name] = value
      }
      let tool = intent.tool
      if (argSpecs.some((a) => a.name === 'reference')) {
        const ref = ORDER_REF.exec(message)
        const modelRef = args.reference
        delete args.reference
        if (ref) args.reference = ref[1]!.toUpperCase()
        else if (entity?.kind === 'order') args.reference = entity.label
        else if (typeof modelRef === 'string' && /\d/.test(modelRef) && grounded(modelRef, message)) args.reference = modelRef.trim()
      }
      if (tool === 'products.search' && args.query === undefined) {
        // "productos sin stock" sin un producto concreto es inventario bajo.
        if (LOW_STOCK.test(text)) tool = 'inventory.low'
        // "¿cuánto queda de esa?": el producto abierto.
        else if (entity?.kind === 'product') args.query = entity.label
      }
      if (!kept.some((k) => k.tool === tool)) kept.push({ tool, args })
    }
  }

  let status: SelectorStatus
  if (kept.length > 0) status = 'tool'
  else if (DEFINITION.test(text)) status = 'chat'
  else if (proposal.status === 'missing') status = proposal.module !== 'none' || STORE_WORDS.test(text) ? 'missing' : 'chat'
  else if (proposal.status === 'ambiguous') status = 'ambiguous'
  else status = 'chat'

  const need = status === 'missing' ? (proposal.need.trim() || message.trim()).slice(0, NEED_MAX_CHARS) : ''
  const module = status === 'chat' ? 'none' : (LUMI_MODULES as readonly string[]).includes(proposal.module) ? proposal.module : 'none'
  return { status, intents: kept.slice(0, 2), need, module }
}

/* ───────────────────────── Interpretación final ───────────────────────── */

export type LumiInterpretation =
  /** Hay herramienta (una o dos) con su entrada validada. El permiso va en `denied`. */
  | { status: 'supported'; matches: ToolMatch[] }
  /** Lo resuelve otra parte de Lumi: el chat (con o sin búsqueda web) o los recordatorios. */
  | { status: 'delegated'; delegate: LumiDelegate }
  /** Falta un dato obligatorio: se pregunta solo eso. */
  | { status: 'missing_information'; tool: string; missing: string[]; ask: string }
  /** La tienda no tiene esa capacidad. La Fase B la registrará en el Capability Manager. */
  | { status: 'missing_capability'; need: string; module: string }
  | { status: 'ambiguous' }
  /** Conversación sin datos de la tienda. */
  | { status: 'unsupported' }

const GENERIC_ASK = 'Me falta un dato para hacerlo. ¿Puedes dármelo?'

/** Construye la interpretación con las herramientas reales: entrada validada y permiso. */
export function interpret(
  message: string,
  normalized: NormalizedProposal,
  permissionKeys: readonly PermissionId[],
  ctx: Pick<LumiToolContext, 'now' | 'timezone'> & { enabled?: EnabledTools },
): LumiInterpretation {
  if (normalized.status === 'missing') return { status: 'missing_capability', need: normalized.need, module: normalized.module }
  if (normalized.status === 'ambiguous') return { status: 'ambiguous' }
  if (normalized.status === 'chat') return { status: 'unsupported' }

  const text = plainText(message)
  const matches: ToolMatch[] = []
  let delegate: LumiDelegate | null = null
  for (const intent of normalized.intents) {
    // Una herramienta deshabilitada se trata como inexistente (el modelo no la ve en su catálogo).
    const tool = selectorTools(ctx.enabled).find((t) => t.name === intent.tool)
    if (!tool) {
      delegate ??= DELEGATES.find((d) => d.name === intent.tool)?.delegate ?? null
      continue
    }
    const denied = !canUseTool(tool, permissionKeys)
    const built = tool.selector!.fromArgs(intent.args, text, ctx)
    if ('missing' in built) {
      // Sin permiso no se pregunta nada: se responde que no tiene permiso, sin leer datos.
      if (denied) {
        matches.push({ tool, input: {} as never, denied: true, explain: false })
        continue
      }
      return { status: 'missing_information', tool: tool.name, missing: built.missing, ask: tool.selector!.ask ?? GENERIC_ASK }
    }
    matches.push({ tool, input: built.input, denied, explain: explainWith(tool, text) })
  }
  if (matches.length > 0) return { status: 'supported', matches }
  if (delegate === 'web' && !hasPermission([...permissionKeys], PERMISSION_REGISTRY.LUMI_WEB)) {
    return { status: 'delegated', delegate: 'chat' }
  }
  return delegate ? { status: 'delegated', delegate } : { status: 'unsupported' }
}

/* ───────────────────────── Respuestas sin modelo ───────────────────────── */

export const REMINDER_HINT =
  'Para crear un recordatorio dime qué y cuándo, por ejemplo: «Recuérdame mañana a las 9 de la mañana llamar al proveedor».'

export const AMBIGUOUS_REPLY =
  'No estoy seguro de qué necesitas. ¿Me lo explicas con un poco más de detalle? Por ejemplo, qué pedido, producto o periodo.'

/**
 * Respuesta cuando falta la capacidad. `registered`: la petición quedó en el Capability Manager
 * (o ya estaba registrada por esta persona hace poco). Solo se dice si es verdad.
 */
export function missingCapabilityReply(need: string, registered = false): string {
  const what = need.replace(/[«»"]/g, '').trim()
  const base = what
    ? `Todavía no tengo una herramienta para «${what}». No voy a usar otra parecida porque podría darte datos que no son los que pides.`
    : 'Todavía no tengo una herramienta para eso. No voy a usar otra parecida porque podría darte datos que no son los que pides.'
  return registered ? `${base} He registrado la petición para que la evalúen en Lumia Admin.` : base
}

import type { PermissionId } from '../../../common/permissions/registry.js'
import type { LumiSelectRequest, LumiSelectResult } from '../infrastructure/lumi-assistant.client.js'
import { entityContextLine } from '../selector/active-entity.js'
import {
  AMBIGUOUS_REPLY,
  interpret,
  normalizeProposal,
  REMINDER_HINT,
  type LumiInterpretation,
  type NormalizedProposal,
} from '../selector/lumi-selector.js'
import { LUMI_TOOLS, matchTool, type ToolMatch } from '../tools/catalog.js'
import { DEVICE_HELP_REPLY } from '../tools/desktop.tools.js'
import {
  GROUP_TOOL_PREFIX,
  groupMenu,
  routeSelectorMenu,
  type LumiToolGroupId,
  type SelectorMenu,
} from '../selector/tool-groups.js'
import type { LumiEntityRef } from '../tools/tool.types.js'

/**
 * Plan de un turno de Lumi en tres etapas: reglas (sin modelo) → selector con Qwen (propone) →
 * Server (valida, completa, comprueba permisos y decide). Lo usan el chat y el entorno de pruebas
 * de capacidades (fase D): lo que se prueba es exactamente lo que hace el chat.
 *
 * No tiene efectos: no ejecuta herramientas, no registra capacidades y no guarda nada. Los
 * recordatorios (etapa 0) los resuelve antes el chat con AutomationCommands.
 */

export type TurnPlan =
  /** Datos de la tienda con texto determinista, sin conversación con el modelo. */
  | { kind: 'tools'; matches: ToolMatch[] }
  /** Respuesta fija del Server: falta un dato, no se entiende o es un recordatorio mal formulado. */
  | { kind: 'reply'; text: string }
  /** Falta la capacidad: quien llama decide si la registra (el chat sí, las pruebas no). */
  | { kind: 'missing_capability'; need: string; module: string }
  /** Conversación con el modelo; con `match`, los datos de esa herramienta van como contexto. */
  | { kind: 'model'; match: ToolMatch | null; forceWeb: boolean }

export interface TurnTraceSelector {
  /** `disabled`: el selector no está activo; `error`: falló o tardó demasiado (el turno sigue como conversación). */
  outcome: 'ok' | 'disabled' | 'error'
  proposal?: { status: LumiSelectResult['status']; intents: LumiSelectResult['intents']; need: string; module: string }
  normalized?: NormalizedProposal
  parseErrors?: number
  latencyMs?: number
  promptTokens?: number
  completionTokens?: number
  model?: string
  error?: string
  /**
   * Selección en dos niveles: menú enviado (`flat` completo, `grouped` un grupo por palabras clave,
   * `mixed` tienda + entradas de grupo), grupo final, tamaño del último menú y llamadas al modelo.
   */
  routing?: { mode: 'flat' | 'grouped' | 'mixed'; group: string | null; menuSize: number; calls: number }
}

/** Lo que pasó en cada etapa, para el entorno de pruebas y las métricas (sin el texto del usuario). */
export interface TurnTrace {
  stage: 'learned' | 'rules' | 'selector' | 'fallback'
  /** Interpretación aprendida que resolvió el turno (fase F), sin la frase. */
  learned: { knowledgeId: string; scope: 'user' | 'global'; tool: string } | null
  rules: { tool: string; denied: boolean; explain: boolean } | null
  /** Ejemplos aprendidos enviados al selector (solo cuántos). */
  examples: number
  selector: TurnTraceSelector | null
  interpretation: LumiInterpretation['status'] | null
  /** Entradas validadas de las herramientas elegidas (valores del Server, no del modelo). */
  matches: Array<{ tool: string; input: unknown; denied: boolean; explain: boolean }>
  /** Herramienta elegida a la que le falta un dato, y qué datos (missing_information). */
  pendingTool: string | null
  missing: string[]
  delegate: string | null
  need: string | null
  module: string | null
}

export interface TurnInput {
  userId: string
  message: string
  permissionKeys: readonly PermissionId[]
  now: Date
  timezone: string
  /** Herramientas habilitadas (fase E). Sin conjunto: todas. */
  enabledTools?: ReadonlySet<string>
  /** Entidad activa (pantalla o conversación). Solo se resuelve si el turno llega al selector. */
  resolveEntity: () => Promise<LumiEntityRef | null>
}

export interface TurnDeps {
  /** null: selector desactivado o asistente sin configurar. */
  select: ((userId: string, payload: LumiSelectRequest) => Promise<LumiSelectResult>) | null
  /** Interpretación aprobada para esta frase exacta (fase F). */
  learned?: (message: string, enabled?: ReadonlySet<string>) => Promise<{ knowledgeId: string; tool: string; scope: 'user' | 'global' } | null>
  /** Interpretaciones aprobadas parecidas, como ejemplos para el selector (fase F). */
  examples?: (message: string, enabled?: ReadonlySet<string>) => Promise<NonNullable<LumiSelectRequest['examples']>>
}

const matchSummary = (m: ToolMatch) => ({
  tool: m.tool.name,
  input: m.input as unknown,
  denied: m.denied,
  explain: m.explain,
})

function emptyTrace(stage: TurnTrace['stage']): TurnTrace {
  return { stage, learned: null, rules: null, examples: 0, selector: null, interpretation: null, matches: [], pendingTool: null, missing: [], delegate: null, need: null, module: null }
}

export async function planLumiTurn(input: TurnInput, deps: TurnDeps): Promise<{ plan: TurnPlan; trace: TurnTrace }> {
  const ctx = { now: input.now, timezone: input.timezone, enabled: input.enabledTools }

  // Etapa 1a: lo que este usuario (o un administrador, globalmente) ya enseñó para esta frase exacta.
  // Va antes de las reglas: es una corrección explícita. Pasa por la misma validación y permisos.
  const learned = deps.learned ? await deps.learned(input.message, input.enabledTools).catch(() => null) : null
  if (learned) {
    const entity = await input.resolveEntity()
    const proposal = { status: 'tool' as const, intents: [{ tool: learned.tool, args: {} }], need: '', module: 'none' }
    const result = interpret(input.message, normalizeProposal(input.message, proposal, entity), [...input.permissionKeys], ctx)
    if (result.status === 'supported' || result.status === 'missing_information') {
      const trace: TurnTrace = { ...emptyTrace('learned'), learned, interpretation: result.status }
      return planFrom(result, trace)
    }
  }

  // Etapa 1b: reglas de las herramientas.
  const match = matchTool(input.message, [...input.permissionKeys], ctx)
  if (match) {
    const trace = { ...emptyTrace('rules'), rules: { tool: match.tool.name, denied: match.denied, explain: match.explain }, interpretation: 'supported' as const, matches: [matchSummary(match)] }
    const plan: TurnPlan = match.explain && !match.denied ? { kind: 'model', match, forceWeb: false } : { kind: 'tools', matches: [match] }
    return { plan, trace }
  }

  if (!deps.select) {
    return { plan: { kind: 'model', match: null, forceWeb: false }, trace: { ...emptyTrace('fallback'), selector: { outcome: 'disabled' }, interpretation: 'unsupported' } }
  }

  // Etapa 2: el selector propone, con el menú que decide la selección en dos niveles.
  const entity = await input.resolveEntity()
  const examples = deps.examples ? await deps.examples(input.message, input.enabledTools).catch(() => []) : []
  const select = deps.select
  const ask = (menu: SelectorMenu) => {
    // Los ejemplos aprendidos solo valen si su herramienta está en este menú.
    const names = new Set(menu.tools.map((t) => t.name))
    const usable = examples.filter((e) => names.has(e.tool))
    return select(input.userId, {
      message: input.message,
      context: entityContextLine(entity),
      ...menu,
      ...(usable.length ? { examples: usable } : {}),
    })
  }
  const routed = routeSelectorMenu(input.message, input.enabledTools, input.permissionKeys)
  const routing: NonNullable<TurnTraceSelector['routing']> = {
    mode: routed.mode,
    group: routed.mode === 'grouped' ? routed.group : null,
    menuSize: routed.menu.tools.length,
    calls: 1,
  }
  let proposal: LumiSelectResult
  try {
    proposal = await ask(routed.menu)
    if (routed.mode === 'mixed') {
      const picked = proposal.intents.find((i) => i.tool.startsWith(GROUP_TOOL_PREFIX))
      const group = picked?.tool.slice(GROUP_TOOL_PREFIX.length) as LumiToolGroupId | undefined
      if (group && routed.groups.includes(group)) {
        // Segundo nivel: el modelo eligió un grupo; ahora elige entre sus herramientas.
        const menu = groupMenu(group, input.enabledTools, input.permissionKeys)
        const second = await ask(menu)
        proposal = {
          ...second,
          latencyMs: (proposal.latencyMs ?? 0) + (second.latencyMs ?? 0),
          promptTokens: (proposal.promptTokens ?? 0) + (second.promptTokens ?? 0),
          completionTokens: (proposal.completionTokens ?? 0) + (second.completionTokens ?? 0),
        }
        routing.group = group
        routing.menuSize = menu.tools.length
        routing.calls = 2
      } else if (picked) {
        // Una entrada de grupo que no estaba en el menú no es una herramienta: se ignora.
        proposal = { ...proposal, intents: proposal.intents.filter((i) => !i.tool.startsWith(GROUP_TOOL_PREFIX)) }
      }
    }
  } catch (err) {
    const error = err instanceof Error ? err.message.slice(0, 200) : 'error'
    return { plan: { kind: 'model', match: null, forceWeb: false }, trace: { ...emptyTrace('fallback'), selector: { outcome: 'error', error }, interpretation: 'unsupported' } }
  }

  // Etapa 3: el Server decide.
  const normalized = normalizeProposal(input.message, proposal, entity)
  const result = interpret(input.message, normalized, [...input.permissionKeys], ctx)
  const trace: TurnTrace = {
    ...emptyTrace('selector'),
    selector: {
      outcome: 'ok',
      proposal: { status: proposal.status, intents: proposal.intents, need: proposal.need, module: proposal.module },
      normalized,
      parseErrors: proposal.errors.length,
      latencyMs: proposal.latencyMs,
      promptTokens: proposal.promptTokens,
      completionTokens: proposal.completionTokens,
      model: proposal.model,
      routing,
    },
    interpretation: result.status,
    module: normalized.module,
    examples: examples.length,
  }
  return planFrom(result, trace)
}

/** Módulos externos (música, equipo): lo que no sabe hacer no es una capacidad de la tienda que falte. */
const EXTERNAL_MODULES: ReadonlySet<string> = new Set(LUMI_TOOLS.filter((t) => t.external).map((t) => t.selector!.module))

function planFrom(result: LumiInterpretation, trace: TurnTrace): { plan: TurnPlan; trace: TurnTrace } {
  switch (result.status) {
    case 'supported': {
      trace.matches = result.matches.map(matchSummary)
      const only = result.matches.length === 1 ? result.matches[0]! : null
      const plan: TurnPlan = only && only.explain && !only.denied ? { kind: 'model', match: only, forceWeb: false } : { kind: 'tools', matches: result.matches }
      return { plan, trace }
    }
    case 'delegated':
      trace.delegate = result.delegate
      return {
        plan: result.delegate === 'reminder' ? { kind: 'reply', text: REMINDER_HINT } : { kind: 'model', match: null, forceWeb: result.delegate === 'web' },
        trace,
      }
    case 'missing_information':
      trace.missing = result.missing
      trace.pendingTool = result.tool
      return { plan: { kind: 'reply', text: result.ask }, trace }
    case 'missing_capability':
      trace.need = result.need
      // Equipos de escritorio: se responde con lo que sí sabe hacer, sin registrar nada en el Capability Manager.
      if (EXTERNAL_MODULES.has(result.module) && result.module === 'equipo') {
        return { plan: { kind: 'reply', text: DEVICE_HELP_REPLY }, trace }
      }
      return { plan: { kind: 'missing_capability', need: result.need, module: result.module }, trace }
    case 'ambiguous':
      return { plan: { kind: 'reply', text: AMBIGUOUS_REPLY }, trace }
    case 'unsupported':
      return { plan: { kind: 'model', match: null, forceWeb: false }, trace }
  }
}


import type { PermissionId } from '../../../../common/permissions/registry.js'
import { parseAutomationCommand } from '../../automation/domain/reminder-parser.js'
import type { LumiSelectRequest, LumiSelectResult } from '../../infrastructure/lumi-assistant.client.js'
import { runTool, type ToolMatch } from '../../tools/catalog.js'
import type { LumiToolDeps } from '../../tools/tool.types.js'
import { planLumiTurn } from '../../turn/turn-plan.js'
import { EXECUTION_TEXT_MAX, type PhraseResult, type ToolExecution } from '../domain/capability-test.types.js'

export interface SandboxInput {
  userId: string
  permissionKeys: readonly PermissionId[]
  message: string
  /** Usar el selector aunque esté desactivado en el chat (para evaluarlo antes de activarlo). */
  forceSelector: boolean
}

export type SandboxOutcome = Pick<PhraseResult, 'actual' | 'automation' | 'trace' | 'executions' | 'durationMs' | 'error'> & {
  /** Todas las herramientas elegidas (para comparar con la esperada). */
  tools: string[]
}

export interface SandboxDeps {
  /** Llamada al selector del asistente; null si no está configurado. */
  select: ((userId: string, payload: LumiSelectRequest) => Promise<LumiSelectResult>) | null
  /** LUMI_SELECTOR_ENABLED: lo que haría el chat hoy. */
  selectorEnabled: boolean
  /** Solo lecturas: es el mismo puerto de lectura que usa el chat. */
  toolDeps: LumiToolDeps
  timezone: string
  clock?: () => Date
}

/**
 * Ejecuta una frase con el mismo plan de turno que el chat y los permisos del administrador.
 * Sin efectos: no crea recordatorios, no registra capacidades, no guarda historial, no llama a la
 * conversación del modelo. Solo ejecuta herramientas del catálogo, que son de lectura.
 */
export class SandboxTurnRunner {
  constructor(private readonly deps: SandboxDeps) {}

  get selectorAvailable(): boolean {
    return this.deps.select !== null
  }

  async run(input: SandboxInput): Promise<SandboxOutcome> {
    const started = Date.now()
    const now = this.deps.clock?.() ?? new Date()

    // Etapa 0 del chat: órdenes de recordatorio por reglas. Aquí solo se detectan.
    const command = parseAutomationCommand(input.message, now, this.deps.timezone)
    if (command.kind !== 'none') {
      return {
        actual: { status: 'delegated', tool: null, reply: 'automation' },
        automation: command.kind,
        trace: null,
        executions: [],
        tools: [],
        durationMs: Date.now() - started,
        error: null,
      }
    }

    const useSelector = input.forceSelector || this.deps.selectorEnabled
    const { plan, trace } = await planLumiTurn(
      {
        userId: input.userId,
        message: input.message,
        permissionKeys: input.permissionKeys,
        now,
        timezone: this.deps.timezone,
        // Sin conversación ni pantalla: la frase se prueba sola.
        resolveEntity: async () => null,
      },
      { select: useSelector ? this.deps.select : null },
    )

    const toRun: ToolMatch[] = plan.kind === 'tools' ? plan.matches : plan.kind === 'model' && plan.match ? [plan.match] : []
    const executions: ToolExecution[] = []
    for (const match of toRun) executions.push(await this.execute(match, input, now))

    const tools = trace.matches.map((m) => m.tool)
    return {
      actual: {
        status: trace.interpretation ?? 'unsupported',
        tool: tools[0] ?? trace.pendingTool,
        reply: plan.kind,
      },
      automation: null,
      trace,
      executions,
      tools,
      durationMs: Date.now() - started,
      error: trace.selector?.outcome === 'error' ? `Selector: ${trace.selector.error ?? 'error'}` : null,
    }
  }

  private async execute(match: ToolMatch, input: SandboxInput, now: Date): Promise<ToolExecution> {
    if (match.denied) {
      return { tool: match.tool.name, denied: true, rows: null, durationMs: 0, text: null, error: null }
    }
    const started = Date.now()
    try {
      const result = await runTool(match, {
        userId: input.userId,
        permissionKeys: input.permissionKeys,
        now,
        timezone: this.deps.timezone,
        deps: this.deps.toolDeps,
      })
      const text = result.text.length > EXECUTION_TEXT_MAX ? `${result.text.slice(0, EXECUTION_TEXT_MAX - 1)}…` : result.text
      return { tool: match.tool.name, denied: false, rows: result.rows, durationMs: Date.now() - started, text, error: null }
    } catch (err) {
      const error = err instanceof Error ? err.message.slice(0, 200) : 'error'
      return { tool: match.tool.name, denied: false, rows: null, durationMs: Date.now() - started, text: null, error }
    }
  }
}

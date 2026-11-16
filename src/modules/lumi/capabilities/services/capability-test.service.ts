import type { PermissionId } from '../../../../common/permissions/registry.js'
import { AppError } from '../../../../common/errors/app.error.js'
import { LUMI_TOOLS } from '../../tools/catalog.js'
import type { CapabilityTestStore } from '../domain/capability-test.store.js'
import {
  evaluate,
  PHRASE_LIMIT,
  RUN_HISTORY_LIMIT,
  RUN_STALE_MS,
  summarize,
  type AddPhraseInput,
  type CapabilityPhrase,
  type CapabilityTestRun,
  type ExpectedStatus,
  type PhraseResult,
  type StartRunInput,
  type UpdatePhraseInput,
} from '../domain/capability-test.types.js'
import type { CapabilityStore } from '../domain/capability.store.js'
import type { CapabilityStatus, LumiCapability } from '../domain/capability.types.js'
import type { SandboxTurnRunner } from './sandbox-runner.js'

export interface Tester {
  userId: string
  permissionKeys: readonly PermissionId[]
}

/** Estados en los que la batería decide el resultado (testing → validated o failed). */
const BATTERY_STATUSES: readonly CapabilityStatus[] = ['ready_for_testing', 'testing', 'failed', 'validated']
/** Herramienta esperada solo tiene sentido si hay herramienta. */
const STATUSES_WITH_TOOL: readonly ExpectedStatus[] = ['supported', 'missing_information']
const TOOL_NAMES: ReadonlySet<string> = new Set(LUMI_TOOLS.map((t) => t.name))

/**
 * «Probar capacidad» (fase D): frases con su resultado esperado y ejecuciones en segundo plano.
 * Nunca habilita nada: como mucho deja la capacidad `validated` (la activación es la fase E).
 */
export class CapabilityTestService {
  constructor(
    private readonly capabilities: CapabilityStore,
    private readonly tests: CapabilityTestStore,
    private readonly runner: SandboxTurnRunner,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async listPhrases(capabilityId: string): Promise<CapabilityPhrase[]> {
    await this.require(capabilityId)
    return this.tests.listPhrases(capabilityId)
  }

  async addPhrase(capabilityId: string, input: AddPhraseInput, by: string): Promise<CapabilityPhrase> {
    const capability = await this.require(capabilityId)
    if (capability.status === 'duplicate') throw AppError.conflict('La capacidad está fusionada con otra')
    if ((await this.tests.countPhrases(capabilityId)) >= PHRASE_LIMIT) {
      throw AppError.conflict(`Máximo ${PHRASE_LIMIT} frases por capacidad`)
    }
    const withTool = STATUSES_WITH_TOOL.includes(input.expectedStatus)
    if (input.expectedTool && (!withTool || !TOOL_NAMES.has(input.expectedTool))) {
      throw AppError.badRequest('Herramienta esperada no válida para ese resultado')
    }
    const text = input.text.replace(/\s+/g, ' ').trim()
    // La misma frase dos veces no aporta nada a la batería.
    const key = text.toLowerCase()
    if ((await this.tests.listPhrases(capabilityId)).some((p) => p.text.toLowerCase() === key)) {
      throw AppError.conflict('Esa frase ya está en las pruebas')
    }
    return this.tests.addPhrase({
      capabilityId,
      text,
      role: input.role,
      expectedStatus: input.expectedStatus,
      expectedTool: withTool ? input.expectedTool : null,
      critical: input.critical,
      createdBy: by,
      createdAt: this.clock(),
    })
  }

  /** Cambia el rol, el resultado esperado o si es crítica, sin borrar la frase. */
  async updatePhrase(capabilityId: string, phraseId: string, input: UpdatePhraseInput): Promise<CapabilityPhrase> {
    const capability = await this.require(capabilityId)
    if (capability.status === 'duplicate') throw AppError.conflict('La capacidad está fusionada con otra')
    const current = (await this.tests.listPhrases(capabilityId)).find((p) => p.id === phraseId)
    if (!current) throw AppError.notFound('Frase no encontrada')
    const status = input.expectedStatus ?? current.expectedStatus
    const withTool = STATUSES_WITH_TOOL.includes(status)
    let tool = input.expectedTool !== undefined ? input.expectedTool : current.expectedTool
    if (!withTool) tool = null
    if (tool && !TOOL_NAMES.has(tool)) throw AppError.badRequest('Herramienta esperada no válida para ese resultado')
    const updated = await this.tests.updatePhrase(capabilityId, phraseId, {
      ...(input.role ? { role: input.role } : {}),
      ...(input.critical !== undefined ? { critical: input.critical } : {}),
      expectedStatus: status,
      expectedTool: tool || null,
    })
    if (!updated) throw AppError.notFound('Frase no encontrada')
    return updated
  }

  async deletePhrase(capabilityId: string, phraseId: string): Promise<void> {
    await this.require(capabilityId)
    if (!(await this.tests.deletePhrase(capabilityId, phraseId))) throw AppError.notFound('Frase no encontrada')
  }

  async listRuns(capabilityId: string) {
    await this.require(capabilityId)
    const runs = await this.tests.listRuns(capabilityId, RUN_HISTORY_LIMIT)
    return runs.map((run) => ({ ...run, status: this.effectiveStatus(run) }))
  }

  async getRun(capabilityId: string, runId: string): Promise<CapabilityTestRun> {
    const run = await this.tests.getRun(capabilityId, runId)
    if (!run) throw AppError.notFound('Ejecución no encontrada')
    return { ...run, status: this.effectiveStatus(run) }
  }

  /**
   * Lanza una prueba en segundo plano y devuelve la ejecución en curso. `completion` termina cuando
   * acaba (las rutas no la esperan; las pruebas automáticas sí).
   */
  async startRun(
    capabilityId: string,
    input: StartRunInput,
    tester: Tester,
  ): Promise<{ run: CapabilityTestRun; completion: Promise<void> }> {
    const capability = await this.require(capabilityId)
    if (capability.status === 'duplicate') throw AppError.conflict('La capacidad está fusionada con otra')
    if (input.forceSelector && !this.runner.selectorAvailable) {
      // 409 y no 503: es configuración, no una caída (el BFF oculta los 5xx con un mensaje genérico).
      throw AppError.conflict('El asistente Lumi no está configurado en el Server: no se puede usar el selector')
    }
    const now = this.clock()
    if (await this.tests.findRunning(capabilityId, new Date(now.getTime() - RUN_STALE_MS))) {
      throw AppError.conflict('Ya hay una prueba en curso para esta capacidad')
    }

    let items: Array<Pick<PhraseResult, 'phraseId' | 'text' | 'role' | 'critical' | 'expected'>>
    if (input.kind === 'single') {
      if (input.expectedTool && !TOOL_NAMES.has(input.expectedTool)) throw AppError.badRequest('Herramienta esperada no válida')
      items = [
        {
          phraseId: null,
          text: input.text,
          role: null,
          critical: false,
          expected: input.expectedStatus ? { status: input.expectedStatus, tool: input.expectedTool ?? null } : null,
        },
      ]
    } else {
      // Las frases de control nunca se ejecutan aquí: solo las mide el banco.
      const phrases = (await this.tests.listPhrases(capabilityId)).filter((p) => p.role !== 'control')
      if (phrases.length === 0) throw AppError.badRequest('Añade al menos una frase de prueba o de validación')
      items = phrases.map((p) => ({
        phraseId: p.id,
        text: p.text,
        role: p.role,
        critical: p.critical,
        expected: { status: p.expectedStatus, tool: p.expectedTool },
      }))
    }

    const run = await this.tests.createRun({
      capabilityId,
      kind: input.kind,
      forceSelector: input.forceSelector,
      by: tester.userId,
      createdAt: now,
    })
    // La batería decide el estado solo si hay frases de validación y la capacidad está en pruebas.
    const decidesStatus =
      input.kind === 'battery' && BATTERY_STATUSES.includes(capability.status) && items.some((i) => i.role === 'validation')
    if (decidesStatus && capability.status !== 'testing') {
      await this.setStatus(capability, 'testing', now)
    }
    const completion = this.execute(run, items, input.forceSelector, tester, decidesStatus ? capabilityId : null, capability.toolName)
    return { run, completion }
  }

  private async execute(
    run: CapabilityTestRun,
    items: Array<Pick<PhraseResult, 'phraseId' | 'text' | 'role' | 'critical' | 'expected'>>,
    forceSelector: boolean,
    tester: Tester,
    decideFor: string | null,
    toolUnderTest: string | null,
  ): Promise<void> {
    const results: PhraseResult[] = []
    try {
      for (const item of items) {
        let result: PhraseResult
        try {
          const outcome = await this.runner.run({
            userId: tester.userId,
            permissionKeys: tester.permissionKeys,
            message: item.text,
            forceSelector,
            includeTools: toolUnderTest ? [toolUnderTest] : [],
          })
          result = {
            ...item,
            actual: outcome.actual,
            passed: evaluate(item.expected, { status: outcome.actual.status, tool: outcome.actual.tool, tools: outcome.tools }),
            automation: outcome.automation,
            trace: outcome.trace,
            executions: outcome.executions,
            durationMs: outcome.durationMs,
            error: outcome.error,
          }
        } catch (err) {
          result = {
            ...item,
            actual: { status: 'error', tool: null, reply: 'model' },
            passed: item.expected ? false : null,
            automation: null,
            trace: null,
            executions: [],
            durationMs: 0,
            error: err instanceof Error ? err.message.slice(0, 200) : 'error',
          }
        }
        results.push(result)
        // Progreso visible mientras corre.
        await this.tests.updateRun(run.id, { results })
      }
      const summary = summarize(results, run.kind === 'battery')
      const finishedAt = this.clock()
      await this.tests.updateRun(run.id, { status: 'done', results, summary, finishedAt })
      if (run.kind === 'battery') {
        const capability = await this.capabilities.findById(run.capabilityId)
        if (capability) {
          const validationAccuracy = summary.validation.total ? summary.validation.passed / summary.validation.total : null
          await this.capabilities.update(
            run.capabilityId,
            { lastTest: { runId: run.id, at: finishedAt, passed: summary.batteryPassed, validationAccuracy } },
            { at: finishedAt, by: run.by, action: 'tested' },
            finishedAt,
          )
          if (decideFor && summary.batteryPassed !== null && capability.status === 'testing') {
            await this.setStatus(capability, summary.batteryPassed ? 'validated' : 'failed', finishedAt)
          }
        }
      }
    } catch (err) {
      await this.tests
        .updateRun(run.id, { status: 'error', results, error: err instanceof Error ? err.message.slice(0, 200) : 'error', finishedAt: this.clock() })
        .catch(() => undefined)
    }
  }

  private async setStatus(capability: LumiCapability, to: CapabilityStatus, at: Date): Promise<void> {
    await this.capabilities.update(capability.id, { status: to }, { at, by: 'system', action: 'status', from: capability.status, to }, at)
    capability.status = to
  }

  private effectiveStatus(run: Pick<CapabilityTestRun, 'status' | 'createdAt'>): CapabilityTestRun['status'] {
    return run.status === 'running' && run.createdAt.getTime() < this.clock().getTime() - RUN_STALE_MS ? 'interrupted' : run.status
  }

  private async require(id: string): Promise<LumiCapability> {
    const capability = await this.capabilities.findById(id)
    if (!capability) throw AppError.notFound('Capacidad no encontrada')
    return capability
  }
}

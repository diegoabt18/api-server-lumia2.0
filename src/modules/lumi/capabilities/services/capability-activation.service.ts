import { AppError } from '../../../../common/errors/app.error.js'
import { isPermissionId } from '../../../../common/permissions/registry.js'
import type { LumiTool } from '../../tools/tool.types.js'
import type { CapabilityStore } from '../domain/capability.store.js'
import { capabilityModule, type CapabilityStatus, type LumiCapability } from '../domain/capability.types.js'
import type { LumiToolGate } from './tool-gate.js'

export interface EnablementCheck {
  key: 'implemented' | 'permission' | 'arguments' | 'validated' | 'documented'
  label: string
  ok: boolean
  detail: string | null
}

/** Estados desde los que se puede habilitar (con la última batería aprobada). */
const ENABLE_FROM: readonly CapabilityStatus[] = ['validated', 'disabled']

/**
 * Activación de capacidades (fase E). El registro de herramientas es el código; si una está
 * habilitada lo decide `lumi_capabilities`. Habilitar es siempre una acción manual, y solo se
 * permite si el Server comprueba que la herramienta existe, su permiso es válido, declara sus
 * argumentos, su última batería pasó y quien la habilita confirma que está documentada.
 */
export class CapabilityActivationService {
  constructor(
    private readonly store: CapabilityStore,
    private readonly tools: ReadonlyArray<LumiTool<never>>,
    private readonly gate: Pick<LumiToolGate, 'invalidate'>,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * Sincronización al arrancar: cada herramienta del registro tiene su capacidad. Las anteriores a
   * la fase E nacen habilitadas (sin cambio de comportamiento); las nuevas, listas para probar y
   * deshabilitadas. Si la capacidad ya existía (detectada desde el chat o creada antes), solo se
   * enlaza: su estado no cambia, así que nada se habilita aquí.
   */
  async syncRegistry(): Promise<Array<{ tool: string; result: 'created' | 'linked' | 'unchanged' }>> {
    const now = this.clock()
    const out: Array<{ tool: string; result: 'created' | 'linked' | 'unchanged' }> = []
    for (const tool of this.tools) {
      const result = await this.store.upsertForTool({
        key: tool.capabilityKey,
        title: tool.capability,
        module: capabilityModule(tool.selector?.module ?? 'none'),
        toolName: tool.name,
        initialStatus: tool.enabledByDefault ? 'enabled' : 'ready_for_testing',
        now,
      })
      out.push({ tool: tool.name, result })
    }
    this.gate.invalidate()
    return out
  }

  /** Lo que falta para poder habilitar (el panel lo muestra; `enable` lo vuelve a comprobar). */
  async checks(id: string, documented = false): Promise<{ capability: LumiCapability; checks: EnablementCheck[]; canEnable: boolean }> {
    const capability = await this.require(id)
    const tool = capability.toolName ? this.tools.find((t) => t.name === capability.toolName) : undefined
    const passed = capability.lastTest?.passed === true
    const checks: EnablementCheck[] = [
      {
        key: 'implemented',
        label: 'La herramienta existe en el registro del Server',
        ok: Boolean(tool),
        detail: tool ? tool.name : capability.toolName ? `«${capability.toolName}» ya no está en el registro` : 'Ninguna herramienta declara esta capacidad',
      },
      {
        key: 'permission',
        label: 'Exige un permiso válido (o solo lumi.use)',
        ok: Boolean(tool) && (tool!.permission === null || isPermissionId(tool!.permission)),
        detail: tool ? (tool.permission ?? 'lumi.use') : null,
      },
      {
        key: 'arguments',
        label: 'Declara sus argumentos para el selector',
        ok: Boolean(tool?.selector),
        detail: tool?.selector ? `${tool.selector.args.length} argumentos` : null,
      },
      {
        key: 'validated',
        label: 'La última batería de pruebas pasó',
        ok: passed && ENABLE_FROM.includes(capability.status),
        detail: !capability.lastTest
          ? 'Sin batería'
          : capability.lastTest.passed === null
            ? 'La última batería no tenía frases de «Validación»'
            : `${passed ? 'Pasó' : 'No pasó'}${capability.lastTest.validationAccuracy !== null ? ` (${Math.round(capability.lastTest.validationAccuracy * 100)} % en validación)` : ''}`,
      },
      { key: 'documented', label: 'Documentación confirmada', ok: documented, detail: null },
    ]
    return { capability, checks, canEnable: capability.status !== 'enabled' && checks.every((c) => c.ok) }
  }

  async enable(id: string, by: string): Promise<LumiCapability> {
    const { capability, checks, canEnable } = await this.checks(id, true)
    if (capability.status === 'enabled') throw AppError.conflict('La capacidad ya está habilitada')
    if (!canEnable) {
      const failed = checks.filter((c) => !c.ok).map((c) => c.label.toLowerCase())
      throw AppError.conflict(`No se puede habilitar: ${failed.join('; ')}`)
    }
    return this.setStatus(capability, 'enabled', by)
  }

  async disable(id: string, by: string): Promise<LumiCapability> {
    const capability = await this.require(id)
    if (capability.status !== 'enabled') throw AppError.conflict('Solo se puede deshabilitar una capacidad habilitada')
    return this.setStatus(capability, 'disabled', by)
  }

  private async setStatus(capability: LumiCapability, to: CapabilityStatus, by: string): Promise<LumiCapability> {
    const now = this.clock()
    await this.store.update(capability.id, { status: to }, { at: now, by, action: 'status', from: capability.status, to }, now)
    // En esta instancia el cambio llega al chat al momento; en otras, en ≤ 60 s.
    this.gate.invalidate()
    return this.require(capability.id)
  }

  private async require(id: string): Promise<LumiCapability> {
    const capability = await this.store.findById(id)
    if (!capability) throw AppError.notFound('Capacidad no encontrada')
    return capability
  }
}

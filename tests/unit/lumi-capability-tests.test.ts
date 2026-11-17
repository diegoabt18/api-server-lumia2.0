import { describe, expect, it } from 'vitest'
import { PERMISSION_REGISTRY as P, type PermissionId } from '../../src/common/permissions/registry.js'
import type { CapabilityTestStore, NewPhrase, NewRun, RunPatch } from '../../src/modules/lumi/capabilities/domain/capability-test.store.js'
import {
  evaluate,
  startRunSchema,
  summarize,
  type CapabilityPhrase,
  type CapabilityTestRun,
  type PhraseResult,
} from '../../src/modules/lumi/capabilities/domain/capability-test.types.js'
import type { CapabilityPatch, CapabilityStore } from '../../src/modules/lumi/capabilities/domain/capability.store.js'
import { EMPTY_SPEC, type CapabilityHistoryEntry, type LumiCapability } from '../../src/modules/lumi/capabilities/domain/capability.types.js'
import { CapabilityTestService } from '../../src/modules/lumi/capabilities/services/capability-test.service.js'
import { SandboxTurnRunner } from '../../src/modules/lumi/capabilities/services/sandbox-runner.js'
import type { LumiSelectRequest, LumiSelectResult } from '../../src/modules/lumi/infrastructure/lumi-assistant.client.js'
import type { LumiToolDeps } from '../../src/modules/lumi/tools/tool.types.js'
import { planLumiTurn } from '../../src/modules/lumi/turn/turn-plan.js'

const NOW = new Date('2026-11-15T15:00:00.000Z')
const TZ = 'America/Bogota'
const ALL: PermissionId[] = [P.LUMI_USE, P.ORDERS_READ, P.PRODUCTS_READ, P.INVENTORY_READ, P.ANALYTICS_READ]

function fakeDeps(): LumiToolDeps & { calls: string[] } {
  const calls: string[] = []
  const t = <A extends unknown[], R>(name: string, fn: (...args: A) => Promise<R>) => (...args: A) => {
    calls.push(name)
    return fn(...args)
  }
  return {
    calls,
    orders: {
      recent: t('orders.recent', async () => []),
      findByReference: t('orders.findByReference', async () => []),
      countByStatus: t('orders.countByStatus', async () => ({ paid: 3 })),
      salesSummary: t('orders.salesSummary', async () => ({ orders: 2, soldOrders: 2, revenue: 100_000, refunds: 0, topProducts: [] })),
    },
    products: {
      untaxed: t('products.untaxed', async () => ({ items: [{ name: 'Vela Sin IVA', status: 'active' }], total: 1 })),
      taxed: t('products.taxed', async () => ({ items: [{ name: 'Vela Con IVA', status: 'active', taxRate: 19 }], total: 1 })),
      unpriced: t('products.unpriced', async () => ({ items: [{ name: 'Vela Sin Precio', status: 'active', variantCount: 1 }], total: 1 })),
      lowStock: t('products.lowStock', async () => [{ name: 'Vela Lavanda', available: 0 }]),
      search: t('products.search', async () => []),
    },
    categories: { list: t('categories.list', async () => ({ items: [], total: 0 })) },
    initiatives: { list: t('initiatives.list', async () => []) },
    notifications: {
      countUnread: t('notifications.countUnread', async () => 0),
      recentUnread: t('notifications.recentUnread', async () => []),
    },
  }
}

const selectReturning =
  (answer: Partial<LumiSelectResult>, seen: LumiSelectRequest[] = []) =>
  async (_userId: string, payload: LumiSelectRequest): Promise<LumiSelectResult> => {
    seen.push(payload)
    return { status: 'chat', intents: [], need: '', module: 'none', errors: [], model: 'q', latencyMs: 5000, promptTokens: 1200, completionTokens: 30, ...answer }
  }

describe('planLumiTurn (plan compartido por el chat y las pruebas)', () => {
  const input = (message: string, keys: PermissionId[] = ALL) => ({
    userId: 'u1',
    message,
    permissionKeys: keys,
    now: NOW,
    timezone: TZ,
    resolveEntity: async () => null,
  })

  it('resolves by rules without calling the selector or resolving the entity', async () => {
    let resolved = false
    const { plan, trace } = await planLumiTurn(
      { ...input('¿cuánto vendimos ayer?'), resolveEntity: async () => ((resolved = true), null) },
      { select: () => Promise.reject(new Error('no debería llamarse')) },
    )
    expect(plan.kind).toBe('tools')
    expect(trace).toMatchObject({ stage: 'rules', interpretation: 'supported', rules: { tool: 'sales.summary' } })
    expect(resolved).toBe(false)
  })

  it('falls back to conversation when the selector is disabled or fails', async () => {
    expect((await planLumiTurn(input('cuéntame algo'), { select: null })).trace).toMatchObject({ stage: 'fallback', selector: { outcome: 'disabled' } })
    const failed = await planLumiTurn(input('cuéntame algo'), { select: () => Promise.reject(new Error('timeout')) })
    expect(failed.plan).toEqual({ kind: 'model', match: null, forceWeb: false })
    expect(failed.trace.selector).toMatchObject({ outcome: 'error', error: 'timeout' })
  })

  it('returns a missing capability without recording anything (the caller decides)', async () => {
    const { plan, trace } = await planLumiTurn(input('productos con reseñas negativas'), {
      select: selectReturning({ status: 'missing', need: 'reseñas negativas', module: 'resenas' }),
    })
    expect(plan).toEqual({ kind: 'missing_capability', need: 'reseñas negativas', module: 'resenas' })
    expect(trace).toMatchObject({ stage: 'selector', interpretation: 'missing_capability', need: 'reseñas negativas' })
    expect(trace.selector).toMatchObject({ outcome: 'ok', latencyMs: 5000, promptTokens: 1200 })
  })

  it('reports the tool that lacks data', async () => {
    const { trace } = await planLumiTurn(input('¿en qué va la orden?'), {
      select: selectReturning({ status: 'tool', intents: [{ tool: 'orders.lookup', args: {} }], module: 'pedidos' }),
    })
    expect(trace).toMatchObject({ interpretation: 'missing_information', pendingTool: 'orders.lookup', missing: ['reference'] })
  })
})

describe('SandboxTurnRunner (sin efectos)', () => {
  const runner = (deps = fakeDeps(), select: ReturnType<typeof selectReturning> | null = null, selectorEnabled = false) =>
    new SandboxTurnRunner({ select, selectorEnabled, toolDeps: deps, timezone: TZ, clock: () => NOW })

  it('detects reminders without creating them', async () => {
    const deps = fakeDeps()
    const out = await runner(deps).run({ userId: 'u1', permissionKeys: ALL, message: 'recuérdame mañana a las 9 pagar la luz', forceSelector: false })
    expect(out.actual).toEqual({ status: 'delegated', tool: null, reply: 'automation' })
    // Cualquier orden de automatización (crear, preguntar el dato…) se detecta y no se ejecuta.
    expect(out.automation).not.toBeNull()
    expect(deps.calls).toEqual([])
  })

  it('executes read tools with the tester permissions and trims the answer', async () => {
    const deps = fakeDeps()
    const out = await runner(deps).run({ userId: 'u1', permissionKeys: ALL, message: '¿qué productos se están agotando?', forceSelector: false })
    expect(out.actual).toMatchObject({ status: 'supported', tool: 'inventory.low', reply: 'tools' })
    expect(out.executions[0]).toMatchObject({ tool: 'inventory.low', denied: false, rows: 1, error: null })
    expect(deps.calls).toEqual(['products.lowStock'])
  })

  it('never reads data without permission', async () => {
    const deps = fakeDeps()
    const out = await runner(deps).run({ userId: 'u1', permissionKeys: [P.LUMI_USE], message: '¿cuánto vendimos ayer?', forceSelector: false })
    expect(out.executions).toEqual([{ tool: 'sales.summary', denied: true, rows: null, durationMs: 0, text: null, error: null }])
    expect(deps.calls).toEqual([])
  })

  it('uses the selector only when enabled or forced, and never with entity context', async () => {
    const seen: LumiSelectRequest[] = []
    const select = selectReturning({ status: 'missing', need: 'reseñas', module: 'resenas' }, seen)
    const disabled = await runner(fakeDeps(), select).run({ userId: 'u1', permissionKeys: ALL, message: 'reseñas malas', forceSelector: false })
    expect(disabled.actual.status).toBe('unsupported')
    expect(seen).toHaveLength(0)
    const forced = await runner(fakeDeps(), select).run({ userId: 'u1', permissionKeys: ALL, message: 'reseñas malas', forceSelector: true })
    expect(forced.actual).toMatchObject({ status: 'missing_capability', reply: 'missing_capability' })
    expect(seen).toHaveLength(1)
    expect(seen[0]!.context).toBeUndefined()
  })
})

describe('evaluation', () => {
  it('compares status and, when given, the tool', () => {
    expect(evaluate(null, { status: 'supported', tool: 'x', tools: ['x'] })).toBeNull()
    expect(evaluate({ status: 'supported', tool: 'inventory.low' }, { status: 'supported', tool: 'products.search', tools: ['products.search', 'inventory.low'] })).toBe(true)
    expect(evaluate({ status: 'supported', tool: 'inventory.low' }, { status: 'supported', tool: 'products.search', tools: ['products.search'] })).toBe(false)
    expect(evaluate({ status: 'missing_capability', tool: null }, { status: 'unsupported', tool: null, tools: [] })).toBe(false)
  })

  it('passes a battery with ≥ 90 % in validation and every critical phrase', () => {
    const r = (role: PhraseResult['role'], passed: boolean, critical = false) => ({ role, passed, critical }) as PhraseResult
    const ten = Array.from({ length: 10 }, (_, i) => r('validation', i !== 0))
    expect(summarize(ten, true).batteryPassed).toBe(true)
    expect(summarize([...ten, r('test', false, true)], true).batteryPassed).toBe(false)
    expect(summarize([r('validation', true), r('validation', false)], true).batteryPassed).toBe(false)
    expect(summarize([r('test', true)], true).batteryPassed).toBeNull()
    expect(summarize(ten, false).batteryPassed).toBeNull()
  })

  it('validates run input strictly', () => {
    expect(startRunSchema.safeParse({ kind: 'single', text: 'hola' }).success).toBe(true)
    expect(startRunSchema.safeParse({ kind: 'battery', text: 'x' }).success).toBe(false)
    expect(startRunSchema.safeParse({ kind: 'execute' }).success).toBe(false)
  })
})

/* ───────────── Servicio con almacenes en memoria ───────────── */

class MemoryStores implements CapabilityTestStore {
  phrases: CapabilityPhrase[] = []
  runs: CapabilityTestRun[] = []
  capability: LumiCapability
  private seq = 0
  constructor(status: LumiCapability['status']) {
    this.capability = {
      id: 'c'.repeat(24), key: 'k', title: 'productos sin precio', description: '', module: 'productos', status, priority: 'normal',
      signature: 's', keywords: [], requestCount: 1, samples: [], spec: { ...EMPTY_SPEC }, mergedInto: null, possibleDuplicateOf: null, toolName: null,
      history: [], lastTest: null, firstSeenAt: NOW, lastSeenAt: NOW, createdAt: NOW, updatedAt: NOW,
    }
  }
  private id() {
    return (++this.seq).toString(16).padStart(24, '0')
  }
  capabilities(): CapabilityStore {
    const notUsed = async () => {
      throw new Error('not used')
    }
    return {
      findById: async (id: string) => (id === this.capability.id ? { ...this.capability } : null),
      update: async (_id: string, patch: CapabilityPatch, entry: CapabilityHistoryEntry) => {
        Object.assign(this.capability, patch)
        this.capability.history = [...this.capability.history, entry]
      },
      create: notUsed, findCandidates: notUsed, addRequest: notUsed, insertRequest: notUsed, hasRecentRequest: notUsed,
      list: notUsed, stats: notUsed, recentRequests: notUsed, distinctUsers: notUsed, absorb: notUsed,
      upsertForTool: notUsed, enabledToolNames: notUsed,
    } as CapabilityStore
  }
  async addPhrase(p: NewPhrase) {
    const phrase = { ...p, id: this.id() }
    this.phrases.push(phrase)
    return phrase
  }
  async listPhrases(id: string) {
    return this.phrases.filter((p) => p.capabilityId === id)
  }
  async countPhrases(id: string) {
    return (await this.listPhrases(id)).length
  }
  async deletePhrase(id: string, phraseId: string) {
    const before = this.phrases.length
    this.phrases = this.phrases.filter((p) => !(p.id === phraseId && p.capabilityId === id))
    return this.phrases.length < before
  }
  async updatePhrase(id: string, phraseId: string, patch: Partial<CapabilityPhrase>) {
    const phrase = this.phrases.find((p) => p.id === phraseId && p.capabilityId === id)
    if (!phrase) return null
    Object.assign(phrase, patch)
    return { ...phrase }
  }
  async movePhrases() {}
  async createRun(run: NewRun) {
    const created: CapabilityTestRun = { ...run, id: this.id(), status: 'running', results: [], summary: null, error: null, finishedAt: null }
    this.runs.push(created)
    return { ...created }
  }
  async updateRun(id: string, patch: RunPatch) {
    Object.assign(this.runs.find((r) => r.id === id)!, patch)
  }
  async getRun(id: string, runId: string) {
    return this.runs.find((r) => r.id === runId && r.capabilityId === id) ?? null
  }
  async listRuns(id: string) {
    return this.runs.filter((r) => r.capabilityId === id)
  }
  async findRunning(id: string, since: Date) {
    return this.runs.find((r) => r.capabilityId === id && r.status === 'running' && r.createdAt >= since) ?? null
  }
}

function service(status: LumiCapability['status'] = 'ready_for_testing') {
  const stores = new MemoryStores(status)
  const runner = new SandboxTurnRunner({ select: null, selectorEnabled: false, toolDeps: fakeDeps(), timezone: TZ, clock: () => NOW })
  return { stores, svc: new CapabilityTestService(stores.capabilities(), stores, runner, () => NOW) }
}
const tester = { userId: 'admin1', permissionKeys: ALL }
const add = (svc: CapabilityTestService, text: string, role: 'test' | 'validation' | 'control', expectedStatus: 'supported' | 'unsupported', expectedTool: string | null = null, critical = false) =>
  svc.addPhrase('c'.repeat(24), { text, role, expectedStatus, expectedTool, critical }, 'admin1')

describe('CapabilityTestService', () => {
  it('no duplica frases y permite cambiar rol, crítica y resultado sin borrarlas', async () => {
    const { svc, stores } = service()
    const phrase = await add(svc, 'productos sin iva', 'test', 'supported', 'inventory.low')
    await expect(add(svc, '  Productos  sin IVA ', 'validation', 'supported')).rejects.toThrow(/ya está/)
    const updated = await svc.updatePhrase('c'.repeat(24), phrase.id, { role: 'validation', critical: true })
    expect(updated).toMatchObject({ role: 'validation', critical: true, expectedStatus: 'supported', expectedTool: 'inventory.low' })
    // Un resultado sin herramienta borra la herramienta esperada.
    expect(await svc.updatePhrase('c'.repeat(24), phrase.id, { expectedStatus: 'unsupported' })).toMatchObject({ expectedTool: null })
    await expect(svc.updatePhrase('c'.repeat(24), phrase.id, { expectedStatus: 'supported', expectedTool: 'db.drop' })).rejects.toThrow(/no válida/)
    await expect(svc.updatePhrase('c'.repeat(24), 'f'.repeat(24), { role: 'test' })).rejects.toThrow(/no encontrada/)
    expect(stores.phrases).toHaveLength(1)
  })

  it('validates phrases: known tool, only with a tool status, and a per-capability limit', async () => {
    const { svc } = service()
    await expect(add(svc, 'x', 'test', 'supported', 'db.drop')).rejects.toThrow(/no válida/)
    await expect(add(svc, 'x', 'test', 'unsupported', 'inventory.low')).rejects.toThrow(/no válida/)
    const ok = await add(svc, '¿qué se está agotando?', 'validation', 'supported', 'inventory.low', true)
    expect(ok).toMatchObject({ role: 'validation', expectedTool: 'inventory.low', critical: true, createdBy: 'admin1' })
  })

  it('runs a battery in the background, skips control phrases and validates the capability', async () => {
    const { svc, stores } = service()
    await add(svc, '¿qué productos se están agotando?', 'validation', 'supported', 'inventory.low', true)
    await add(svc, '¿cuánto vendimos ayer?', 'test', 'supported', 'sales.summary')
    await add(svc, 'frase de control', 'control', 'supported', 'inventory.low')
    const { run, completion } = await svc.startRun('c'.repeat(24), { kind: 'battery', forceSelector: false }, tester)
    expect(run.status).toBe('running')
    expect(stores.capability.status).toBe('testing')
    await completion
    const done = await svc.getRun('c'.repeat(24), run.id)
    expect(done.status).toBe('done')
    expect(done.results.map((r) => r.text)).not.toContain('frase de control')
    expect(done.summary).toMatchObject({ total: 2, passed: 2, validation: { total: 1, passed: 1 }, batteryPassed: true })
    expect(stores.capability.status).toBe('validated')
    expect(stores.capability.lastTest).toMatchObject({ runId: run.id, passed: true, validationAccuracy: 1 })
    expect(stores.capability.history.map((h) => h.action)).toEqual(['status', 'tested', 'status'])
  })

  it('marks the capability failed when validation fails, and never enables it', async () => {
    const { svc, stores } = service('failed')
    await add(svc, 'productos sin precio', 'validation', 'supported', 'products.search')
    const { completion } = await svc.startRun('c'.repeat(24), { kind: 'battery', forceSelector: false }, tester)
    await completion
    expect(stores.capability.status).toBe('failed')
    expect(stores.capability.lastTest?.passed).toBe(false)
  })

  it('does not touch the status for single phrases or capabilities still in review', async () => {
    const { svc, stores } = service('pending_review')
    await add(svc, '¿qué productos se están agotando?', 'validation', 'supported', 'inventory.low')
    await (await svc.startRun('c'.repeat(24), { kind: 'battery', forceSelector: false }, tester)).completion
    expect(stores.capability.status).toBe('pending_review')
    const single = await svc.startRun('c'.repeat(24), { kind: 'single', text: 'hola', forceSelector: false }, tester)
    await single.completion
    expect((await svc.getRun('c'.repeat(24), single.run.id)).results[0]).toMatchObject({ passed: null, actual: { status: 'unsupported' } })
  })

  it('refuses a second run while one is in progress, empty batteries and forcing an unconfigured selector', async () => {
    const { svc } = service()
    await expect(svc.startRun('c'.repeat(24), { kind: 'battery', forceSelector: false }, tester)).rejects.toThrow(/al menos una frase/)
    await expect(svc.startRun('c'.repeat(24), { kind: 'single', text: 'hola', forceSelector: true }, tester)).rejects.toThrow(/no está configurado/)
    const stores = (svc as unknown as { tests: MemoryStores }).tests
    await stores.createRun({ capabilityId: 'c'.repeat(24), kind: 'battery', forceSelector: false, by: 'otro', createdAt: NOW })
    await expect(svc.startRun('c'.repeat(24), { kind: 'single', text: 'otra', forceSelector: false }, tester)).rejects.toThrow(/en curso/)
    // Una «en curso» de hace más de 30 minutos se da por interrumpida y ya no bloquea.
    stores.runs[0]!.createdAt = new Date(NOW.getTime() - 31 * 60_000)
    expect((await svc.listRuns('c'.repeat(24)))[0]!.status).toBe('interrupted')
    await (await svc.startRun('c'.repeat(24), { kind: 'single', text: 'otra', forceSelector: false }, tester)).completion
  })
})

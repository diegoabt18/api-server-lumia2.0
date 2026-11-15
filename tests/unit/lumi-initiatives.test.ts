import { describe, expect, it } from 'vitest'
import {
  detectFailedRoutines,
  detectStaleOrders,
  detectStock,
  DAY_MS,
  type InitiativeCandidate,
} from '../../src/modules/lumi/initiatives/domain/initiative.detectors.js'
import { shouldNotify } from '../../src/modules/lumi/initiatives/domain/initiative.rules.js'
import {
  canTransition,
  type InitiativeKind,
  type InitiativeLevel,
  type InitiativeState,
  type LumiInitiative,
} from '../../src/modules/lumi/initiatives/domain/initiative.types.js'
import type { InitiativeStore, NewInitiative, InitiativePatch } from '../../src/modules/lumi/initiatives/domain/initiative.store.js'
import {
  InitiativeEngine,
  type InitiativeNotifier,
  type InitiativeSources,
} from '../../src/modules/lumi/initiatives/services/initiative-engine.js'
import { InitiativeScheduler } from '../../src/modules/lumi/initiatives/services/initiative-scheduler.js'
import type { AutomationLock } from '../../src/modules/lumi/automation/domain/automation.store.js'
import { LumiInitiativeService } from '../../src/modules/lumi/initiatives/services/initiative.service.js'
import { PERMISSION_REGISTRY as P, type PermissionId } from '../../src/common/permissions/registry.js'

const NOW = new Date('2026-06-10T15:00:00.000Z')

describe('detectores de iniciativas', () => {
  it('stock: sin unidades prioridad 3, stock bajo prioridad 2, el resto no genera nada', () => {
    const out = detectStock(
      [
        { slug: 'a', name: 'A', available: 0 },
        { slug: 'b', name: 'B', available: 2 },
        { slug: 'c', name: 'C', available: 10 },
      ],
      3,
    )
    expect(out.map((c) => [c.subjectKey, c.priority])).toEqual([
      ['a', 3],
      ['b', 2],
    ])
  })

  it('pedidos: solo a partir del plazo y prioridad 3 al doble', () => {
    const rows = [
      { id: 'o1', orderNumber: 'ORD-1', createdAt: new Date(NOW.getTime() - 2 * DAY_MS) },
      { id: 'o2', orderNumber: null, createdAt: new Date(NOW.getTime() - 4 * DAY_MS) },
      { id: 'o3', orderNumber: 'ORD-3', createdAt: new Date(NOW.getTime() - 7 * DAY_MS) },
    ]
    const out = detectStaleOrders(rows, NOW, 3)
    expect(out.map((c) => [c.subjectKey, c.priority])).toEqual([
      ['o2', 2],
      ['o3', 3],
    ])
    expect(out[0]!.detail).toContain('o2')
  })

  it('rutinas: solo ejecuciones agotadas dentro de la ventana', () => {
    const out = detectFailedRoutines(
      [
        { taskId: 't1', status: 'dead', finishedAt: new Date(NOW.getTime() - DAY_MS) },
        { taskId: 't2', status: 'dead', finishedAt: new Date(NOW.getTime() - 30 * DAY_MS) },
        { taskId: 't3', status: 'failed', finishedAt: new Date(NOW.getTime() - DAY_MS) },
        { taskId: 't4', status: 'succeeded', finishedAt: NOW },
      ],
      NOW,
      7,
    )
    expect(out.map((c) => c.subjectKey)).toEqual(['t1'])
  })
})

describe('reglas de iniciativas', () => {
  it('discreta nunca notifica; equilibrada solo urgentes; proactiva todas', () => {
    expect(shouldNotify('discreta', 3)).toBe(false)
    expect(shouldNotify('equilibrada', 2)).toBe(false)
    expect(shouldNotify('equilibrada', 3)).toBe(true)
    expect(shouldNotify('proactiva', 1)).toBe(true)
  })

  it('transiciones: las decididas por la persona son definitivas', () => {
    expect(canTransition('nueva', 'aceptada')).toBe(true)
    expect(canTransition('aceptada', 'completada')).toBe(true)
    expect(canTransition('rechazada', 'pendiente')).toBe(false)
    expect(canTransition('descartada', 'nueva')).toBe(false)
    expect(canTransition('aceptada', 'nueva')).toBe(false)
  })
})

class MemoryInitiatives implements InitiativeStore {
  items: LumiInitiative[] = []
  levels = new Map<string, InitiativeLevel>()
  reviewUsers: string[] = []
  private seq = 0

  async insert(item: NewInitiative): Promise<LumiInitiative | null> {
    if (this.items.some((i) => i.userId === item.userId && i.dedupKey === item.dedupKey)) return null
    const rec: LumiInitiative = {
      id: String(++this.seq).padStart(24, '0'),
      ...item,
      resolvedAt: null,
      createdAt: item.firstSeenAt,
      updatedAt: item.firstSeenAt,
    }
    this.items.push(rec)
    return rec
  }

  async findForUser(id: string, userId: string) {
    return this.items.find((i) => i.id === id && i.userId === userId) ?? null
  }

  async listForUser(
    userId: string,
    options: { state?: InitiativeState; limit: number; kinds?: readonly InitiativeKind[] },
  ) {
    return this.items
      .filter(
        (i) =>
          i.userId === userId &&
          (!options.state || i.state === options.state) &&
          (!options.kinds || options.kinds.includes(i.kind)),
      )
      .slice(0, options.limit)
  }

  async update(id: string, patch: InitiativePatch) {
    const item = this.items.find((i) => i.id === id)
    if (!item) throw new Error('missing')
    Object.assign(item, patch)
  }

  async getLevel(userId: string) {
    return this.levels.get(userId) ?? 'equilibrada'
  }

  async setLevel(userId: string, level: InitiativeLevel) {
    this.levels.set(userId, level)
  }

  async listUsersWithReviewRoutine() {
    return [...this.reviewUsers]
  }
}

function fakeSources() {
  const state = {
    global: [] as InitiativeCandidate[],
    personal: new Map<string, InitiativeCandidate[]>(),
    truncated: [] as InitiativeKind[],
    failGlobal: false,
    failUsers: new Set<string>(),
  }
  const sources: InitiativeSources = {
    async globalCandidates() {
      if (state.failGlobal) throw new Error('catalog unavailable')
      return { candidates: [...state.global], truncated: [...state.truncated] }
    },
    async userCandidates(userId) {
      if (state.failUsers.has(userId)) throw new Error('boom')
      return { candidates: state.personal.get(userId) ?? [], truncated: [] }
    },
  }
  return { state, sources }
}

const outOfStock = (slug: string, priority: 2 | 3 = 3): InitiativeCandidate => ({
  kind: 'stock',
  subjectKey: slug,
  title: priority === 3 ? 'Producto sin stock' : 'Stock bajo',
  detail: `${slug} detalle`,
  priority,
})

function setup(level: InitiativeLevel = 'equilibrada', permissions?: Record<string, PermissionId[]>) {
  const store = new MemoryInitiatives()
  store.reviewUsers = ['u1']
  store.levels.set('u1', level)
  const { state, sources } = fakeSources()
  const sent: Array<{ userId: string; title: string; data: Record<string, string> }> = []
  const notifier: InitiativeNotifier = {
    async notify(input) {
      sent.push({ userId: input.userId, title: input.title, data: input.data })
    },
  }
  const errors: Array<{ userId?: string }> = []
  let clock = NOW
  const engine = new InitiativeEngine(
    store,
    sources,
    notifier,
    () => clock,
    (_err, userId) => errors.push({ userId }),
    permissions ? async (userId) => permissions[userId] ?? [] : null,
  )
  return {
    store,
    state,
    sent,
    errors,
    engine,
    advance(ms: number) {
      clock = new Date(clock.getTime() + ms)
    },
  }
}

describe('motor de iniciativas', () => {
  it('equilibrada: crea todas, notifica solo las urgentes y no repite en la siguiente pasada', async () => {
    const t = setup('equilibrada')
    t.state.global = [outOfStock('a', 3), outOfStock('b', 2)]

    const first = await t.engine.runOnce()
    expect(first.created).toBe(2)
    expect(t.sent.map((n) => n.data.initiativeId)).toHaveLength(1)
    expect(t.store.items).toHaveLength(2)

    const second = await t.engine.runOnce()
    expect(second.created).toBe(0)
    expect(second.notified).toBe(0)
    expect(t.store.items).toHaveLength(2)
  })

  it('discreta: crea iniciativas pero no notifica', async () => {
    const t = setup('discreta')
    t.state.global = [outOfStock('a', 3)]
    await t.engine.runOnce()
    expect(t.store.items).toHaveLength(1)
    expect(t.sent).toHaveLength(0)
  })

  it('proactiva: notifica también las de prioridad baja', async () => {
    const t = setup('proactiva')
    t.state.global = [outOfStock('b', 2)]
    await t.engine.runOnce()
    expect(t.sent).toHaveLength(1)
  })

  it('escalar de stock bajo a sin stock notifica una vez más', async () => {
    const t = setup('equilibrada')
    t.state.global = [outOfStock('b', 2)]
    await t.engine.runOnce()
    expect(t.sent).toHaveLength(0)

    t.state.global = [outOfStock('b', 3)]
    await t.engine.runOnce()
    expect(t.sent).toHaveLength(1)
    expect(t.store.items[0]!.priority).toBe(3)
  })

  it('una señal que desaparece completa la iniciativa; si vuelve, se reabre y notifica otra vez', async () => {
    const t = setup('proactiva')
    t.state.global = [outOfStock('a', 3)]
    await t.engine.runOnce()

    t.state.global = []
    t.advance(60_000)
    const resolved = await t.engine.runOnce()
    expect(resolved.completed).toBe(1)
    expect(t.store.items[0]!.state).toBe('completada')
    expect(t.store.items[0]!.resolvedAt).not.toBeNull()

    t.state.global = [outOfStock('a', 3)]
    const reopened = await t.engine.runOnce()
    expect(reopened.reopened).toBe(1)
    expect(t.store.items[0]!.state).toBe('nueva')
    expect(t.store.items[0]!.openCount).toBe(2)
    expect(t.sent.map((n) => n.data.executionId)).toHaveLength(2)
    expect(new Set(t.sent.map((n) => n.data.executionId)).size).toBe(2)
  })

  it('una iniciativa rechazada no se recrea ni notifica aunque la señal siga', async () => {
    const t = setup('proactiva')
    t.state.global = [outOfStock('a', 3)]
    await t.engine.runOnce()
    t.store.items[0]!.state = 'rechazada'
    const before = t.sent.length

    await t.engine.runOnce()
    expect(t.store.items).toHaveLength(1)
    expect(t.store.items[0]!.state).toBe('rechazada')
    expect(t.sent.length).toBe(before)
  })

  it('usuarios sin revisión diaria no reciben iniciativas', async () => {
    const t = setup('proactiva')
    t.store.reviewUsers = []
    t.state.global = [outOfStock('a', 3)]
    const summary = await t.engine.runOnce()
    expect(summary.users).toBe(0)
    expect(t.store.items).toHaveLength(0)
  })

  it('un usuario con error no detiene a los demás', async () => {
    const t = setup('proactiva')
    t.store.reviewUsers = ['bad', 'u1']
    t.state.failUsers.add('bad')
    t.state.global = [outOfStock('a', 3)]
    await t.engine.runOnce()
    expect(t.errors).toEqual([{ userId: 'bad' }])
    expect(t.store.items.filter((i) => i.userId === 'u1')).toHaveLength(1)
  })

  it('si falla una fuente global no completa nada: una lectura incompleta no resuelve iniciativas', async () => {
    const t = setup('proactiva')
    t.state.global = [outOfStock('a', 3)]
    await t.engine.runOnce()
    t.state.failGlobal = true
    await expect(t.engine.runOnce()).rejects.toThrow('catalog unavailable')
    expect(t.store.items[0]!.state).toBe('nueva')
  })

  it('señales repetidas del mismo sujeto se colapsan con la prioridad más alta', async () => {
    const t = setup('equilibrada')
    t.state.global = [outOfStock('a', 2), outOfStock('a', 3)]
    await t.engine.runOnce()
    expect(t.store.items).toHaveLength(1)
    expect(t.store.items[0]!.priority).toBe(3)
  })
})

const staleOrder = (id: string): InitiativeCandidate => ({
  kind: 'order_attention',
  subjectKey: id,
  title: 'Pedido pagado sin despachar',
  detail: `El pedido ${id} lleva 7 días pagado y sin despachar.`,
  priority: 3,
})

describe('iniciativas y permisos (A1)', () => {
  it('cada usuario solo recibe los tipos de datos que puede ver', async () => {
    const t = setup('proactiva', {
      catalog: [P.LUMI_USE, P.PRODUCTS_READ],
      sales: [P.LUMI_USE, P.ORDERS_READ],
      none: [P.LUMI_USE],
    })
    t.store.reviewUsers = ['catalog', 'sales', 'none']
    t.state.global = [outOfStock('a', 3), staleOrder('o1')]
    await t.engine.runOnce()
    const kindsOf = (u: string) => t.store.items.filter((i) => i.userId === u).map((i) => i.kind)
    expect(kindsOf('catalog')).toEqual(['stock'])
    expect(kindsOf('sales')).toEqual(['order_attention'])
    expect(kindsOf('none')).toEqual([])
    expect(t.sent.map((n) => n.userId).sort()).toEqual(['catalog', 'sales'])
  })

  it('sin lumi.use no se generan iniciativas aunque la rutina siga activa', async () => {
    const t = setup('proactiva', { u1: [P.PRODUCTS_READ, P.ORDERS_READ] })
    t.state.global = [outOfStock('a', 3)]
    await t.engine.runOnce()
    expect(t.store.items).toHaveLength(0)
    expect(t.sent).toHaveLength(0)
  })

  it('el comodín da acceso a todos los tipos', async () => {
    const t = setup('proactiva', { u1: ['*' as PermissionId] })
    t.state.global = [outOfStock('a', 3), staleOrder('o1')]
    await t.engine.runOnce()
    expect(t.store.items).toHaveLength(2)
  })

  it('perder el permiso no marca como completadas las iniciativas existentes', async () => {
    const perms: Record<string, PermissionId[]> = { u1: [P.LUMI_USE, P.ORDERS_READ] }
    const t = setup('proactiva', perms)
    t.state.global = [staleOrder('o1')]
    await t.engine.runOnce()
    perms.u1 = [P.LUMI_USE]
    await t.engine.runOnce()
    expect(t.store.items[0]!.state).toBe('nueva')
  })

  it('el listado y los cambios de estado ocultan los tipos sin permiso', async () => {
    const t = setup('proactiva')
    t.state.global = [outOfStock('a', 3), staleOrder('o1')]
    await t.engine.runOnce()
    const service = new LumiInitiativeService(t.store, () => NOW)
    const visible = await service.list('u1', [P.LUMI_USE, P.PRODUCTS_READ], { limit: 50 })
    expect(visible.map((i) => i.kind)).toEqual(['stock'])
    const order = t.store.items.find((i) => i.kind === 'order_attention')!
    await expect(service.changeState('u1', [P.LUMI_USE, P.PRODUCTS_READ], order.id, 'descartada')).rejects.toThrow(
      'Iniciativa no encontrada',
    )
    const updated = await service.changeState('u1', [P.LUMI_USE, P.ORDERS_READ], order.id, 'descartada')
    expect(updated.state).toBe('descartada')
  })
})

describe('lecturas truncadas (A5)', () => {
  it('un tipo truncado no completa las iniciativas que no aparecieron', async () => {
    const t = setup('proactiva')
    t.state.global = [outOfStock('a', 3), outOfStock('b', 3), staleOrder('o1')]
    await t.engine.runOnce()
    // Siguiente pasada: la lectura de stock llegó al límite y solo trae "a"; la de pedidos está completa.
    t.state.global = [outOfStock('a', 3)]
    t.state.truncated = ['stock']
    const summary = await t.engine.runOnce()
    const byKey = Object.fromEntries(t.store.items.map((i) => [i.subjectKey, i.state]))
    expect(byKey).toEqual({ a: 'nueva', b: 'nueva', o1: 'completada' })
    expect(summary.completed).toBe(1)
  })

  it('cuando la lectura vuelve a estar completa, lo resuelto se completa sin reabrir en bucle', async () => {
    const t = setup('proactiva')
    t.state.global = [outOfStock('a', 3), outOfStock('b', 3)]
    await t.engine.runOnce()
    t.state.global = [outOfStock('a', 3)]
    t.state.truncated = ['stock']
    await t.engine.runOnce()
    t.state.truncated = []
    await t.engine.runOnce()
    const b = t.store.items.find((i) => i.subjectKey === 'b')!
    expect(b.state).toBe('completada')
    expect(b.openCount).toBe(1)
  })
})

describe('scheduler de iniciativas', () => {
  class FixedLock implements AutomationLock {
    held = false
    async tryAcquire() {
      if (this.held) return false
      this.held = true
      return true
    }
    async release() {
      this.held = false
    }
  }

  it('no ejecuta si otra instancia tiene el lock y libera tras ejecutar', async () => {
    const t = setup('proactiva')
    t.state.global = [outOfStock('a', 3)]
    const lock = new FixedLock()
    const scheduler = new InitiativeScheduler(t.engine, lock, { tickMs: 1000, lockTtlMs: 1000, firstRunDelayMs: 1000 })

    lock.held = true
    expect(await scheduler.tick()).toBe(false)
    expect(t.store.items).toHaveLength(0)

    lock.held = false
    expect(await scheduler.tick()).toBe(true)
    expect(t.store.items).toHaveLength(1)
    expect(lock.held).toBe(false)
  })
})

describe('fuentes de iniciativas (A5)', () => {
  it('marca como truncado el tipo cuya lectura llega al límite', async () => {
    const { RepositoryInitiativeSources, INITIATIVE_THRESHOLDS } = await import(
      '../../src/modules/lumi/initiatives/infrastructure/initiative-sources.js'
    )
    const thresholds = { ...INITIATIVE_THRESHOLDS, scanLimit: 2, executionsPerUser: 2 }
    const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ slug: `p${i}`, name: `P${i}`, available: 0 }))
    let stockRows = rows(2)
    const sources = new RepositoryInitiativeSources(
      { findStockAlerts: async () => stockRows } as never,
      { findPaidBefore: async () => [] } as never,
      { listExecutionsForUser: async () => [{}, {}].map(() => ({ taskId: 't', status: 'succeeded', finishedAt: NOW })) } as never,
      thresholds,
    )
    expect((await sources.globalCandidates(NOW)).truncated).toEqual(['stock'])
    stockRows = rows(1)
    expect((await sources.globalCandidates(NOW)).truncated).toEqual([])
    expect((await sources.userCandidates('u1', NOW)).truncated).toEqual(['routine_failed'])
  })
})

import { describe, expect, it } from 'vitest'
import {
  capabilityKey,
  capabilityKeywords,
  compareKeywords,
} from '../../src/modules/lumi/capabilities/domain/capability-signature.js'
import type {
  CapabilityPatch,
  CapabilityStore,
  NewCapability,
  NewCapabilityRequest,
} from '../../src/modules/lumi/capabilities/domain/capability.store.js'
import {
  canTransition,
  CAPABILITY_STATUSES,
  EMPTY_SPEC,
  listCapabilitiesQuerySchema,
  updateCapabilitySchema,
  type CapabilityHistoryEntry,
  type LumiCapability,
} from '../../src/modules/lumi/capabilities/domain/capability.types.js'
import { LumiCapabilityService } from '../../src/modules/lumi/capabilities/services/capability.service.js'
import { missingCapabilityReply } from '../../src/modules/lumi/selector/lumi-selector.js'

/** Almacén en memoria con la misma semántica que el repositorio de MongoDB. */
class MemoryCapabilityStore implements CapabilityStore {
  capabilities: LumiCapability[] = []
  requests: Array<NewCapabilityRequest> = []
  private seq = 0

  async create(input: NewCapability): Promise<LumiCapability> {
    const id = (++this.seq).toString(16).padStart(24, '0')
    const capability: LumiCapability = {
      id, key: input.key, title: input.title, description: '', module: input.module, status: 'detected',
      priority: 'normal', signature: input.signature, keywords: input.keywords, requestCount: 1,
      samples: [input.sample], spec: { ...EMPTY_SPEC }, mergedInto: null, possibleDuplicateOf: input.possibleDuplicateOf, toolName: null,
      history: [{ at: input.now, by: 'system', action: 'created' }], lastTest: null, firstSeenAt: input.now, lastSeenAt: input.now,
      createdAt: input.now, updatedAt: input.now,
    }
    this.capabilities.push(capability)
    return { ...capability }
  }
  async findById(id: string) {
    const found = this.capabilities.find((c) => c.id === id)
    return found ? { ...found } : null
  }
  async findCandidates(keywords: readonly string[]) {
    return this.capabilities.filter((c) => c.keywords.some((k) => keywords.includes(k)))
  }
  async addRequest(id: string, sample: string, at: Date) {
    const c = this.capabilities.find((x) => x.id === id)!
    c.requestCount += 1
    c.lastSeenAt = at
    c.samples = [...c.samples, sample].slice(-5)
  }
  async insertRequest(request: NewCapabilityRequest) {
    this.requests.push(request)
  }
  async hasRecentRequest(userId: string, signature: string, since: Date) {
    return this.requests.some((r) => r.userId === userId && r.signature === signature && r.createdAt >= since)
  }
  async list() {
    return { items: this.capabilities, total: this.capabilities.length }
  }
  async stats() {
    return { total: this.capabilities.length, byStatus: {}, byModule: {}, requestsSince: this.requests.length }
  }
  async recentRequests(capabilityId: string) {
    return this.requests.filter((r) => r.capabilityId === capabilityId).map((r) => ({ message: r.message, createdAt: r.createdAt }))
  }
  async distinctUsers(capabilityId: string) {
    return new Set(this.requests.filter((r) => r.capabilityId === capabilityId).map((r) => r.userId)).size
  }
  async update(id: string, patch: CapabilityPatch, entry: CapabilityHistoryEntry) {
    const c = this.capabilities.find((x) => x.id === id)!
    Object.assign(c, patch)
    c.history = [...c.history, entry]
  }
  async upsertForTool(): Promise<'unchanged'> {
    return 'unchanged'
  }
  async enabledToolNames() {
    return this.capabilities.filter((c) => c.status === 'enabled' && c.toolName).map((c) => c.toolName!)
  }
  async absorb(targetId: string, sourceId: string, requestCount: number, samples: string[], entry: CapabilityHistoryEntry) {
    const t = this.capabilities.find((x) => x.id === targetId)!
    t.requestCount += requestCount
    t.samples = [...t.samples, ...samples].slice(-5)
    t.history = [...t.history, entry]
    for (const r of this.requests) if (r.capabilityId === sourceId) r.capabilityId = targetId
    for (const c of this.capabilities) if (c.mergedInto === sourceId) c.mergedInto = targetId
    for (const c of this.capabilities) if (c.possibleDuplicateOf === sourceId) c.possibleDuplicateOf = c.id === targetId ? null : targetId
  }
}

const T0 = new Date('2026-11-15T15:00:00.000Z')

function setup() {
  const store = new MemoryCapabilityStore()
  let now = T0
  const service = new LumiCapabilityService(store, () => now, () => 'abc123')
  const at = (minutes: number) => {
    now = new Date(T0.getTime() + minutes * 60_000)
  }
  const ask = (userId: string, message: string, module: string, need = '') =>
    service.recordMissing({ userId, conversationId: 'c1', message, need, module })
  return { store, service, at, ask }
}

describe('capability signature', () => {
  it('ignores request verbs, generic nouns and accents, and applies synonyms and stems', () => {
    expect(capabilityKeywords('¿Puedes decirme qué productos tienen más reseñas negativas?')).toEqual(['negativo', 'resena'])
    expect(capabilityKeywords('opiniones malas de los productos')).toEqual(['negativo', 'resena'])
    expect(capabilityKeywords('descarga la lista de todos los productos')).toEqual(['exportar'])
    expect(capabilityKeywords('productos sin categoría')).toEqual(capabilityKeywords('productos sin categorias'))
  })

  it('groups the same request said differently and never on modifiers alone', () => {
    const screen = capabilityKeywords('puedes decirme o explicarme que puedo hacer en esta pantalla')
    expect(compareKeywords(screen, capabilityKeywords('que puedes hacer en esta pagina?')).match).toBe('same')
    // "sin precio" y "sin iva" solo comparten "sin": son capacidades distintas.
    expect(compareKeywords(capabilityKeywords('productos sin precio'), capabilityKeywords('productos sin iva')).match).toBe('none')
    // "usuario" solo nombra la entidad.
    expect(compareKeywords(capabilityKeywords('este usuario esta activo'), capabilityKeywords('whatsapp de este usuario')).match).toBe('none')
  })

  it('builds readable keys without unsafe characters', () => {
    expect(capabilityKey('resenas', ['negativo', 'resena'], 'abc123')).toBe('resenas-negativo-resena-abc123')
    expect(capabilityKey('none', [], 'x$1')).toBe('none-peticion-x1')
  })
})

describe('capability lifecycle', () => {
  it('only allows manual transitions up to ready_for_testing; testing and enabling belong to the Server', () => {
    expect(canTransition('detected', 'pending_review')).toBe(true)
    expect(canTransition('pending_review', 'approved')).toBe(true)
    expect(canTransition('rejected', 'pending_review')).toBe(true)
    for (const from of CAPABILITY_STATUSES) {
      expect(canTransition(from, 'enabled')).toBe(false)
      expect(canTransition(from, 'validated')).toBe(false)
      expect(canTransition(from, 'duplicate')).toBe(false)
    }
    expect(canTransition('detected', 'in_development')).toBe(false)
  })

  it('validates admin input strictly', () => {
    expect(updateCapabilitySchema.safeParse({}).success).toBe(false)
    expect(updateCapabilitySchema.safeParse({ status: 'enabled' }).success).toBe(false)
    expect(updateCapabilitySchema.safeParse({ spec: { rules: 'precio nulo, excluir cero' } }).success).toBe(true)
    expect(listCapabilitiesQuerySchema.safeParse({ limit: '500' }).success).toBe(false)
  })
})

describe('LumiCapabilityService.recordMissing', () => {
  it('creates a capability, then adds similar requests to it', async () => {
    const { store, ask, at } = setup()
    const first = await ask('u1', 'productos con más reseñas negativas', 'resenas', 'productos con reseñas negativas')
    expect(first).toMatchObject({ recorded: true, created: true })
    at(1)
    const second = await ask('u2', 'qué productos tienen opiniones malas', 'resenas')
    expect(second).toMatchObject({ recorded: true, created: false })
    expect(store.capabilities).toHaveLength(1)
    expect(store.capabilities[0]).toMatchObject({ requestCount: 2, status: 'detected', title: 'productos con reseñas negativas' })
    expect(store.requests).toHaveLength(2)
  })

  it('does not count the same person repeating the same request within 10 minutes', async () => {
    const { store, ask, at } = setup()
    await ask('u1', 'productos sin precio', 'productos')
    at(5)
    expect(await ask('u1', 'productos sin precio', 'productos')).toEqual({ recorded: false, reason: 'repeat' })
    at(11)
    expect(await ask('u1', 'productos sin precio', 'productos')).toMatchObject({ recorded: true, created: false })
    expect(store.capabilities[0]!.requestCount).toBe(2)
  })

  it('keeps different needs apart and only suggests a doubtful match', async () => {
    const { store, ask } = setup()
    await ask('u1', 'productos sin categoria', 'productos')
    await ask('u1', 'productos sin subcategorias', 'productos')
    await ask('u1', 'explicame para que sirve la opcion categorias en esta pagina', 'none')
    expect(store.capabilities).toHaveLength(3)
    // Comparte "categ" con la primera: posible duplicado, la fusión la decide el administrador.
    expect(store.capabilities[2]!.possibleDuplicateOf).toBe(store.capabilities[0]!.id)
    expect(store.capabilities[1]!.possibleDuplicateOf).toBeNull()
  })

  it('sanitizes and bounds what it stores', async () => {
    const { store, ask } = setup()
    await ask('u1', `exporta\u0000 los pedidos\n${'x'.repeat(900)}`, 'otro-modulo', 'exportar pedidos')
    expect(store.requests[0]!.message.length).toBe(500)
    expect([...store.requests[0]!.message].some((ch) => ch.charCodeAt(0) < 32)).toBe(false)
    expect(store.capabilities[0]!.module).toBe('none')
  })
})

describe('LumiCapabilityService admin actions', () => {
  it('changes status only through allowed transitions and records who did it', async () => {
    const { store, service, ask } = setup()
    await ask('u1', 'productos sin precio', 'productos')
    const id = store.capabilities[0]!.id
    await expect(service.changeStatus(id, 'enabled', 'admin1')).rejects.toThrow(/no permitida/)
    const updated = await service.changeStatus(id, 'pending_review', 'admin1')
    expect(updated.status).toBe('pending_review')
    expect(updated.history.at(-1)).toMatchObject({ by: 'admin1', action: 'status', from: 'detected', to: 'pending_review' })
  })

  it('merges a duplicate into its target, moving requests and counts', async () => {
    const { store, service, ask } = setup()
    await ask('u1', 'productos sin categoria', 'productos')
    await ask('u2', 'productos sin categoria asignada', 'productos', 'productos sin categoria')
    await ask('u1', 'productos sin subcategorias', 'productos')
    // Las dos primeras ya se agruparon; la de subcategorías quedó aparte.
    expect(store.capabilities).toHaveLength(2)
    const [target, source] = store.capabilities
    expect(target!.requestCount).toBe(2)
    const merged = await service.merge(source!.id, target!.id, 'admin1')
    expect(merged.requestCount).toBe(3)
    expect(store.capabilities[1]).toMatchObject({ status: 'duplicate', mergedInto: target!.id })
    expect(store.requests.every((r) => r.capabilityId === target!.id)).toBe(true)
    await expect(service.merge(source!.id, target!.id, 'admin1')).rejects.toThrow(/fusionada/)
    await expect(service.update(source!.id, { title: 'otra' }, 'admin1')).rejects.toThrow(/fusionada/)
  })

  it('merges the specification instead of replacing it, and lists without history or spec', async () => {
    const { store, service, ask } = setup()
    await ask('u1', 'productos sin precio', 'productos')
    const id = store.capabilities[0]!.id
    await service.update(id, { spec: { expectedResult: 'lista de productos' } }, 'admin1')
    const updated = await service.update(id, { spec: { rules: 'precio nulo o cero' }, priority: 'high' }, 'admin1')
    expect(updated.spec).toMatchObject({ expectedResult: 'lista de productos', rules: 'precio nulo o cero' })
    const listed = await service.list(listCapabilitiesQuerySchema.parse({}))
    expect(listed.items[0]).not.toHaveProperty('history')
    expect(listed.items[0]).not.toHaveProperty('spec')
    expect(listed.pagination.total).toBe(1)
  })

  it('returns detail with recent phrases but without their authors', async () => {
    const { store, service, ask } = setup()
    await ask('u1', 'productos sin precio', 'productos')
    const detail = await service.get(store.capabilities[0]!.id)
    expect(detail.distinctUsers).toBe(1)
    expect(detail.recentRequests[0]).toEqual({ message: 'productos sin precio', createdAt: T0 })
    await expect(service.get('f'.repeat(24))).rejects.toThrow(/no encontrada/)
  })
})

describe('missingCapabilityReply', () => {
  it('only says the request was registered when it was', () => {
    expect(missingCapabilityReply('productos sin precio')).not.toContain('registrado')
    expect(missingCapabilityReply('productos sin precio', true)).toContain('He registrado la petición')
  })
})

import { describe, expect, it } from 'vitest'
import { PERMISSION_REGISTRY as P, type PermissionId } from '../../src/common/permissions/registry.js'
import type { KnowledgeEvent, KnowledgeStore, NewKnowledge } from '../../src/modules/lumi/learning/domain/knowledge.store.js'
import {
  confirmationAnswer,
  correctionTarget,
  feedbackSchema,
  listKnowledgeQuerySchema,
  normalizePhrase,
  phraseSimilarity,
  type KnowledgeScope,
  type KnowledgeStatus,
  type LumiKnowledge,
} from '../../src/modules/lumi/learning/domain/knowledge.types.js'
import { LumiLearningService } from '../../src/modules/lumi/learning/services/learning.service.js'
import { LUMI_TOOLS } from '../../src/modules/lumi/tools/catalog.js'
import { planLumiTurn } from '../../src/modules/lumi/turn/turn-plan.js'

const NOW = new Date('2026-11-15T15:00:00.000Z')
const TZ = 'America/Bogota'
const ALL: PermissionId[] = [P.LUMI_USE, P.ORDERS_READ, P.PRODUCTS_READ, P.INVENTORY_READ, P.ANALYTICS_READ]
const BUILTIN = new Set(LUMI_TOOLS.filter((t) => t.enabledByDefault).map((t) => t.name))

class MemoryKnowledge implements KnowledgeStore {
  items: LumiKnowledge[] = []
  events: KnowledgeEvent[] = []
  last = new Map<string, { message: string; at: Date }>()
  private seq = 0
  async create(i: NewKnowledge) {
    const k: LumiKnowledge = {
      id: (++this.seq).toString(16).padStart(24, '0'), kind: 'interpretation', scope: i.scope, userId: i.userId, phrase: i.phrase,
      phraseNorm: i.phraseNorm, tool: i.tool, status: i.status, source: i.source, conversationId: i.conversationId, uses: 0,
      lastUsedAt: null, createdBy: i.createdBy, createdAt: i.now, updatedAt: i.now,
    }
    this.items.push(k)
    return { ...k }
  }
  async findById(id: string) {
    const k = this.items.find((x) => x.id === id)
    return k ? { ...k } : null
  }
  private applies = (k: LumiKnowledge, userId: string) => (k.scope === 'user' && k.userId === userId) || k.scope === 'global'
  async findApproved(userId: string, phraseNorm: string) {
    return this.items.filter((k) => k.status === 'approved' && k.phraseNorm === phraseNorm && this.applies(k, userId))
  }
  async listApprovedFor(userId: string) {
    return this.items.filter((k) => k.status === 'approved' && this.applies(k, userId))
  }
  async findByPhrase(scope: KnowledgeScope, userId: string | null, phraseNorm: string, statuses: readonly KnowledgeStatus[]) {
    return this.items.filter((k) => k.scope === scope && k.userId === userId && k.phraseNorm === phraseNorm && statuses.includes(k.status))
  }
  async findPendingConfirmation(userId: string, since: Date) {
    return [...this.items].reverse().find((k) => k.userId === userId && k.status === 'detected' && k.source === 'text' && k.createdAt >= since) ?? null
  }
  async countActiveForUser(userId: string) {
    return this.items.filter((k) => k.userId === userId && ['approved', 'detected', 'pending_review'].includes(k.status)).length
  }
  async setStatus(id: string, status: KnowledgeStatus) {
    this.items.find((k) => k.id === id)!.status = status
  }
  async markUsed(id: string) {
    this.items.find((k) => k.id === id)!.uses++
  }
  async delete(id: string) {
    const before = this.items.length
    this.items = this.items.filter((k) => k.id !== id)
    return this.items.length < before
  }
  async list() {
    return { items: this.items, total: this.items.length }
  }
  async addEvent(e: KnowledgeEvent) {
    this.events.push(e)
  }
  async listEvents(id: string) {
    return this.events.filter((e) => e.knowledgeId === id)
  }
  async setLastMessage(userId: string, message: string, at: Date) {
    this.last.set(userId, { message, at })
  }
  async getLastMessage(userId: string, since: Date) {
    const v = this.last.get(userId)
    return v && v.at >= since ? v.message : null
  }
}

function setup(enabled: ReadonlySet<string> = new Set([...BUILTIN, 'products.unpriced'])) {
  const store = new MemoryKnowledge()
  const missing: Array<{ message: string; need: string }> = []
  let now = NOW
  const svc = new LumiLearningService(
    store,
    {
      tools: LUMI_TOOLS,
      enabledTools: async () => enabled,
      recordMissing: async (i) => (missing.push({ message: i.message, need: i.need }), { recorded: true }),
      timezone: TZ,
    },
    () => now,
  )
  return { store, svc, missing, at: (min: number) => (now = new Date(NOW.getTime() + min * 60_000)) }
}
const ana = { userId: 'ana', permissionKeys: ALL }

describe('texto', () => {
  it('normaliza cortesía y artículos y mide el parecido', () => {
    expect(normalizePhrase('Lumi, por favor dime: ¿Cuánto VENDIMOS hoy?')).toBe('cuanto vendimos hoy')
    expect(phraseSimilarity('lo de hoy', 'lo de hoy')).toBe(1)
    expect(phraseSimilarity(normalizePhrase('novedades importantes'), normalizePhrase('novedades de hoy'))).toBeGreaterThan(0.3)
  })

  it('reconoce correcciones y confirmaciones, y nada más', () => {
    expect(correctionTarget('no, me refiero a productos sin stock')).toBe('productos sin stock')
    expect(correctionTarget('quise decir las ventas de ayer')).toBe('las ventas de ayer')
    expect(correctionTarget('no me gusta esa vela')).toBeNull()
    expect(confirmationAnswer('Sí, guárdalo')).toBe('yes')
    expect(confirmationAnswer('no')).toBe('no')
    expect(confirmationAnswer('sí quiero ver las ventas de mañana')).toBeNull()
  })

  it('valida la entrada del botón', () => {
    expect(feedbackSchema.safeParse({ message: 'lo de hoy', tool: 'sales.summary' }).success).toBe(true)
    expect(feedbackSchema.safeParse({ message: 'lo de hoy', tool: 'sales.summary', wanted: 'algo' }).success).toBe(false)
    expect(feedbackSchema.safeParse({ message: 'lo de hoy' }).success).toBe(false)
    expect(listKnowledgeQuerySchema.safeParse({ limit: 500 }).success).toBe(false)
  })
})

describe('botón «No era esto»', () => {
  it('aprende para ese usuario solo herramientas que ya puede usar', async () => {
    const { svc, store } = setup()
    const saved = await svc.recordFeedback(ana, { message: 'lo de hoy', tool: 'sales.summary' })
    expect(saved).toMatchObject({ saved: 'interpretation', knowledge: { scope: 'user', status: 'approved', tool: 'sales.summary' } })
    await expect(svc.recordFeedback({ userId: 'luis', permissionKeys: [P.LUMI_USE] }, { message: 'lo de hoy', tool: 'sales.summary' })).rejects.toThrow(/no está disponible/)
    await expect(svc.recordFeedback(ana, { message: 'lo de hoy', tool: 'db.drop' })).rejects.toThrow(/no está disponible/)
    expect(store.items.filter((k) => k.status === 'approved')).toHaveLength(1)
  })

  it('no aprende órdenes de recordatorio: la etapa 0 del chat las resuelve siempre antes', async () => {
    const { svc, store } = setup()
    await expect(svc.recordFeedback(ana, { message: 'recuérdame mañana a las 9 pagar la luz', tool: 'sales.summary' })).rejects.toThrow(/recordatorio/)
    expect(store.items).toHaveLength(0)
  })

  it('no aprende herramientas deshabilitadas', async () => {
    const { svc } = setup(BUILTIN)
    await expect(svc.recordFeedback(ana, { message: 'productos sin precio', tool: 'products.unpriced' })).rejects.toThrow(/no está disponible/)
    expect((await svc.feedbackOptions(ALL)).map((o) => o.tool)).not.toContain('products.unpriced')
  })

  it('repetir no duplica; cambiar de herramienta retira la anterior', async () => {
    const { svc, store } = setup()
    await svc.recordFeedback(ana, { message: 'lo de hoy', tool: 'sales.summary' })
    await svc.recordFeedback(ana, { message: 'Lumi, lo de hoy', tool: 'sales.summary' })
    expect(store.items).toHaveLength(1)
    await svc.recordFeedback(ana, { message: 'lo de hoy', tool: 'orders.count' })
    expect(store.items.map((k) => `${k.tool}:${k.status}`)).toEqual(['sales.summary:deprecated', 'orders.count:approved'])
  })

  it('«otra cosa» registra la capacidad que falta, no una interpretación', async () => {
    const { svc, store, missing } = setup()
    expect(await svc.recordFeedback(ana, { message: 'reseñas malas', wanted: 'productos con reseñas negativas' })).toEqual({ saved: 'capability', registered: true })
    expect(missing).toEqual([{ message: 'reseñas malas', need: 'productos con reseñas negativas' }])
    expect(store.items).toHaveLength(0)
  })
})

describe('uso en el chat', () => {
  it('la del usuario gana a la global; globales que se contradicen no se usan; probar no cuenta como uso', async () => {
    const { svc, store } = setup()
    await store.create({ scope: 'global', userId: null, phrase: 'lo de hoy', phraseNorm: 'lo hoy', tool: 'orders.count', status: 'approved', source: 'panel', conversationId: null, createdBy: 'admin', now: NOW })
    expect(await svc.learnedTool('luis', 'lo de hoy')).toMatchObject({ tool: 'orders.count', scope: 'global' })
    await svc.recordFeedback(ana, { message: 'lo de hoy', tool: 'sales.summary' })
    expect(await svc.learnedTool('ana', 'lo de hoy')).toMatchObject({ tool: 'sales.summary', scope: 'user' })
    const used = store.items.find((k) => k.scope === 'user')!.uses
    await svc.learnedTool('ana', 'lo de hoy', undefined, false)
    expect(store.items.find((k) => k.scope === 'user')!.uses).toBe(used)
    await store.create({ scope: 'global', userId: null, phrase: 'lo de hoy', phraseNorm: 'lo hoy', tool: 'inventory.low', status: 'approved', source: 'panel', conversationId: null, createdBy: 'admin', now: NOW })
    expect(await svc.learnedTool('luis', 'lo de hoy')).toBeNull()
  })

  it('una herramienta deshabilitada no se usa aunque esté aprendida', async () => {
    const { svc } = setup()
    await svc.recordFeedback(ana, { message: 'qué falta por cobrar', tool: 'products.unpriced' })
    expect(await svc.learnedTool('ana', 'qué falta por cobrar', BUILTIN)).toBeNull()
  })

  it('elige ejemplos parecidos (no la frase exacta) para el selector', async () => {
    const { svc } = setup()
    await svc.recordFeedback(ana, { message: 'novedades importantes', tool: 'notifications.unread' })
    await svc.recordFeedback(ana, { message: 'cuánto vendimos', tool: 'sales.summary' })
    expect(await svc.examples('ana', 'hay novedades importantes hoy')).toEqual([{ message: 'novedades importantes', tool: 'notifications.unread', args: {} }])
    expect(await svc.examples('ana', 'novedades importantes')).toEqual([])
    expect(await svc.examples('luis', 'hay novedades importantes hoy')).toEqual([])
  })

  it('planLumiTurn: lo aprendido va antes que las reglas y nunca concede permisos', async () => {
    const turn = (message: string, keys: PermissionId[], tool: string) =>
      planLumiTurn(
        { userId: 'ana', message, permissionKeys: keys, now: NOW, timezone: TZ, resolveEntity: async () => null },
        { select: null, learned: async () => ({ knowledgeId: 'k1', tool, scope: 'user' }) },
      )
    const learned = await turn('lo de hoy', ALL, 'sales.summary')
    expect(learned.trace).toMatchObject({ stage: 'learned', learned: { knowledgeId: 'k1' }, interpretation: 'supported' })
    expect(learned.plan.kind).toBe('tools')
    // Los datos salen del mensaje: «hoy» es el periodo.
    expect((learned.trace.matches[0]!.input as { range: { label: string } }).range.label).toBe('hoy')
    const denied = await turn('lo de hoy', [P.LUMI_USE], 'sales.summary')
    expect(denied.trace.matches[0]).toMatchObject({ tool: 'sales.summary', denied: true })
    const ask = await turn('cómo va ese', ALL, 'orders.lookup')
    expect(ask.trace).toMatchObject({ stage: 'learned', interpretation: 'missing_information', pendingTool: 'orders.lookup' })
  })
})

describe('correcciones por texto', () => {
  it('pregunta, guarda con «sí» y solo para ese usuario', async () => {
    const { svc, store } = setup()
    await svc.rememberLastMessage('ana', 'lo pendiente de hoy')
    const ask = await svc.handleTextTurn(ana, 'no, me refiero a las ventas de hoy')
    expect(ask).toMatch(/^¿Guardo que «lo pendiente de hoy» significa/)
    expect(store.items[0]).toMatchObject({ status: 'detected', tool: 'sales.summary', source: 'text' })
    expect(await svc.handleTextTurn({ userId: 'luis', permissionKeys: ALL }, 'sí')).toBeNull()
    expect(await svc.handleTextTurn(ana, 'sí')).toMatch(/^Guardado/)
    expect(store.items[0]!.status).toBe('approved')
    expect(await svc.learnedTool('ana', 'lo pendiente de hoy')).toMatchObject({ tool: 'sales.summary' })
  })

  it('«no» descarta; sin pregunta reciente no hace nada; la espera caduca', async () => {
    const { svc, store, at } = setup()
    expect(await svc.handleTextTurn(ana, 'sí')).toBeNull()
    expect(await svc.handleTextTurn(ana, 'no, me refiero a las ventas de hoy')).toBeNull()
    await svc.rememberLastMessage('ana', 'lo pendiente')
    await svc.handleTextTurn(ana, 'quise decir pedidos pendientes')
    expect(await svc.handleTextTurn(ana, 'no')).toBe('De acuerdo, no lo guardo.')
    expect(store.items[0]!.status).toBe('rejected')
    at(1)
    await svc.rememberLastMessage('ana', 'lo pendiente')
    await svc.handleTextTurn(ana, 'quise decir pedidos pendientes')
    at(12)
    expect(await svc.handleTextTurn(ana, 'sí')).toBeNull()
  })

  it('si lo corregido no tiene herramienta, lo registra como capacidad que falta', async () => {
    const { svc, store, missing } = setup()
    await svc.rememberLastMessage('ana', 'reseñas malas')
    expect(await svc.handleTextTurn(ana, 'me refiero a productos con reseñas negativas')).toMatch(/He registrado la petición/)
    expect(missing).toEqual([{ message: 'reseñas malas', need: 'productos con resenas negativas' }])
    expect(store.items).toHaveLength(0)
  })
})

describe('panel de aprendizaje', () => {
  it('hacer global solo por un administrador; si contradice otra global, ambas a revisión', async () => {
    const { svc, store } = setup()
    const a = await svc.recordFeedback(ana, { message: 'lo de hoy', tool: 'sales.summary' })
    const id = a.saved === 'interpretation' ? a.knowledge.id : ''
    const global = await svc.promote(id, 'admin1')
    expect(global).toMatchObject({ scope: 'global', status: 'approved', tool: 'sales.summary' })
    await expect(svc.promote(id, 'admin1')).rejects.toThrow(/Ya existe/)
    const b = await svc.recordFeedback({ userId: 'luis', permissionKeys: ALL }, { message: 'lo de hoy', tool: 'orders.count' })
    const other = await svc.promote(b.saved === 'interpretation' ? b.knowledge.id : '', 'admin1')
    expect(other.status).toBe('pending_review')
    expect(store.items.find((k) => k.id === global.id)!.status).toBe('pending_review')
    await svc.changeStatus(global.id, 'approved', 'admin1')
    await expect(svc.changeStatus(other.id, 'approved', 'admin1')).rejects.toThrow(/Contradice/)
  })

  it('el panel no expone quién la creó ni su conversación', async () => {
    const { svc } = setup()
    await svc.recordFeedback(ana, { message: 'lo de hoy', tool: 'sales.summary' })
    const { items } = await svc.list(listKnowledgeQuerySchema.parse({}))
    expect(items[0]).not.toHaveProperty('userId')
    expect(items[0]).not.toHaveProperty('createdBy')
    expect(items[0]).toMatchObject({ toolExists: true, toolLabel: expect.stringContaining('Ventas') })
    const detail = await svc.get(items[0]!.id)
    expect(detail.events.map((e) => e.by)).toEqual(['user', 'user'])
  })

  it('transiciones permitidas y borrado con registro', async () => {
    const { svc, store } = setup()
    const a = await svc.recordFeedback(ana, { message: 'lo de hoy', tool: 'sales.summary' })
    const id = a.saved === 'interpretation' ? a.knowledge.id : ''
    await expect(svc.changeStatus(id, 'detected', 'admin1')).rejects.toThrow(/no permitida/)
    expect((await svc.changeStatus(id, 'deprecated', 'admin1')).status).toBe('deprecated')
    await svc.delete(id, 'admin1')
    expect(store.items).toHaveLength(0)
    expect(store.events.at(-1)).toMatchObject({ action: 'deleted', by: 'admin1' })
  })
})

/**
 * Fase B de Lumi: Capability Manager contra un MongoDB real y desechable.
 *
 *   MONGO_TEST_URI=mongodb://127.0.0.1:27018 npm run test:integration
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoClient, type Db } from 'mongodb'
import { listCapabilitiesQuerySchema } from '../../src/modules/lumi/capabilities/domain/capability.types.js'
import { LumiCapabilityRepository } from '../../src/modules/lumi/capabilities/infrastructure/lumi-capability.repository.js'
import { LumiCapabilityService } from '../../src/modules/lumi/capabilities/services/capability.service.js'

const uri = process.env.MONGO_TEST_URI
const describeIfDb = uri ? describe : describe.skip

describeIfDb('Lumi fase B: Capability Manager (MongoDB real)', () => {
  let client: MongoClient
  let db: Db
  let repo: LumiCapabilityRepository
  let service: LumiCapabilityService
  const T0 = new Date('2026-11-15T15:00:00.000Z')
  let now = T0
  let seq = 0

  beforeAll(async () => {
    client = await new MongoClient(uri!).connect()
    db = client.db(`lumi_capabilities_it_${Date.now()}`)
    repo = new LumiCapabilityRepository(db)
    await repo.ensureIndexes()
    service = new LumiCapabilityService(repo, () => now, () => `s${++seq}`)
  })

  afterAll(async () => {
    await db?.dropDatabase()
    await client?.close()
  })

  const ask = (userId: string, message: string, module: string, need = '') =>
    service.recordMissing({ userId, conversationId: 'conv-1', message, need, module })
  const list = (query: Record<string, unknown> = {}) => service.list(listCapabilitiesQuerySchema.parse(query))

  it('registers, groups and throttles requests', async () => {
    const first = await ask('u1', 'productos con más reseñas negativas', 'resenas', 'productos con reseñas negativas')
    expect(first).toMatchObject({ recorded: true, created: true })
    now = new Date(T0.getTime() + 60_000)
    expect(await ask('u2', '¿qué productos tienen opiniones malas?', 'resenas')).toMatchObject({ recorded: true, created: false })
    expect(await ask('u2', '¿qué productos tienen opiniones malas?', 'resenas')).toEqual({ recorded: false, reason: 'repeat' })
    await ask('u1', 'descarga la lista de todos los productos', 'productos', 'exportar productos')
    await ask('u1', 'productos sin precio o valor', 'productos')

    const { items, pagination } = await list({ sort: 'requests' })
    expect(pagination.total).toBe(3)
    expect(items[0]).toMatchObject({ module: 'resenas', requestCount: 2, status: 'detected' })
    expect(items[0]!.samples).toEqual(['productos con más reseñas negativas', '¿qué productos tienen opiniones malas?'])
    expect(await db.collection('lumi_capability_requests').countDocuments()).toBe(4)
  })

  it('filters, searches and reports stats', async () => {
    expect((await list({ module: 'productos' })).pagination.total).toBe(2)
    expect((await list({ search: 'opiniones' })).items).toHaveLength(1)
    // La búsqueda es texto literal, no una expresión regular del usuario.
    expect((await list({ search: '.*' })).items).toHaveLength(0)
    const stats = await service.stats()
    expect(stats).toMatchObject({ total: 3, byStatus: { detected: 3 }, requestsSince: 4 })
  })

  it('applies admin changes, merges duplicates and keeps the detail free of authors', async () => {
    const { items } = await list({ module: 'productos', sort: 'created' })
    const [price, exportAll] = items
    await service.update(price!.id, { priority: 'high', spec: { rules: 'precio nulo o cero' } }, 'admin1')
    await service.changeStatus(price!.id, 'pending_review', 'admin1')
    await expect(service.changeStatus(price!.id, 'enabled', 'admin1')).rejects.toThrow()

    await service.merge(exportAll!.id, price!.id, 'admin1')
    const detail = await service.get(price!.id)
    expect(detail.capability).toMatchObject({ status: 'pending_review', priority: 'high', requestCount: 2 })
    expect(detail.capability.spec.rules).toBe('precio nulo o cero')
    expect(detail.capability.history.map((h) => h.action)).toEqual(['created', 'updated', 'status', 'merged_from'])
    expect(detail.recentRequests).toHaveLength(2)
    expect(detail.recentRequests[0]).not.toHaveProperty('userId')
    expect(detail.distinctUsers).toBe(1)
    expect((await service.get(exportAll!.id)).capability).toMatchObject({ status: 'duplicate', mergedInto: price!.id })

    // Una petición nueva igual a la fusionada se suma al destino; la duplicada no se reabre.
    now = new Date(T0.getTime() + 60 * 60_000)
    expect(await ask('u3', 'descarga la lista de todos los productos', 'productos', 'exportar productos')).toMatchObject({ created: false, capabilityId: price!.id })
    expect((await service.get(exportAll!.id)).capability).toMatchObject({ status: 'duplicate', requestCount: 1 })
    expect((await service.get(price!.id)).capability.requestCount).toBe(3)
  })

  it('creates its indexes', async () => {
    const names = (await db.collection('lumi_capabilities').indexes()).map((i) => i.name)
    expect(names).toEqual(expect.arrayContaining(['lumi_capabilities_key_unique', 'lumi_capabilities_keywords_status']))
    const requestIndexes = (await db.collection('lumi_capability_requests').indexes()).map((i) => i.name)
    expect(requestIndexes).toContain('lumi_capability_requests_user_signature')
  })
})

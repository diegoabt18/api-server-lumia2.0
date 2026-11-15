/**
 * Fase D de Lumi: «Probar capacidad» contra un MongoDB real y desechable, de principio a fin con una
 * herramienta existente (orders.count) y los repositorios reales.
 *
 *   MONGO_TEST_URI=mongodb://127.0.0.1:27018 npm run test:integration
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoClient, ObjectId, type Db } from 'mongodb'
import { PERMISSION_REGISTRY as P } from '../../src/common/permissions/registry.js'
import { ProductRepository } from '../../src/modules/catalog/infrastructure/product.repository.js'
import { NotificationRepository } from '../../src/modules/notifications/infrastructure/notification.repository.js'
import { OrderRepository } from '../../src/modules/sales/infrastructure/order.repository.js'
import { LumiCapabilityRepository } from '../../src/modules/lumi/capabilities/infrastructure/lumi-capability.repository.js'
import { LumiCapabilityTestRepository } from '../../src/modules/lumi/capabilities/infrastructure/lumi-capability-test.repository.js'
import { CapabilityTestService } from '../../src/modules/lumi/capabilities/services/capability-test.service.js'
import { LumiCapabilityService } from '../../src/modules/lumi/capabilities/services/capability.service.js'
import { SandboxTurnRunner } from '../../src/modules/lumi/capabilities/services/sandbox-runner.js'
import { LumiInitiativeRepository } from '../../src/modules/lumi/initiatives/infrastructure/lumi-initiative.repository.js'
import { LumiInitiativeService } from '../../src/modules/lumi/initiatives/services/initiative.service.js'
import { createLumiToolDeps } from '../../src/modules/lumi/tools/tool-adapters.js'

const uri = process.env.MONGO_TEST_URI
const describeIfDb = uri ? describe : describe.skip

describeIfDb('Lumi fase D: probar capacidad (MongoDB real)', () => {
  let client: MongoClient
  let db: Db
  let capabilities: LumiCapabilityService
  let tests: CapabilityTestService
  let testRepo: LumiCapabilityTestRepository
  let capabilityId: string
  const NOW = new Date()
  const tester = { userId: 'admin-it', permissionKeys: [P.LUMI_USE, P.ORDERS_READ] }

  beforeAll(async () => {
    client = await new MongoClient(uri!).connect()
    db = client.db(`lumi_capability_tests_it_${Date.now()}`)
    const capabilityRepo = new LumiCapabilityRepository(db)
    await capabilityRepo.ensureIndexes()
    testRepo = new LumiCapabilityTestRepository(db)
    await testRepo.ensureIndexes()
    capabilities = new LumiCapabilityService(capabilityRepo, undefined, undefined, testRepo)
    const runner = new SandboxTurnRunner({
      select: null,
      selectorEnabled: false,
      toolDeps: createLumiToolDeps({
        orders: new OrderRepository(db),
        products: new ProductRepository(db),
        notifications: new NotificationRepository(db),
        initiatives: new LumiInitiativeService(new LumiInitiativeRepository(db)),
      }),
      timezone: 'America/Bogota',
    })
    tests = new CapabilityTestService(capabilityRepo, testRepo, runner)

    await db.collection('orders').insertMany([
      { _id: new ObjectId(), orderNumber: 'ORD-1', status: 'pending', paymentStatus: 'pending', total: 1000, createdAt: NOW, items: [], customerName: 'Ana', email: 'ana@example.com' },
      { _id: new ObjectId(), orderNumber: 'ORD-2', status: 'pending', paymentStatus: 'pending', total: 2000, createdAt: NOW, items: [] },
    ])
    const recorded = await capabilities.recordMissing({ userId: 'u1', conversationId: null, message: 'pedidos que faltan por pagar', need: 'pedidos por pagar', module: 'pedidos' })
    capabilityId = recorded.recorded ? recorded.capabilityId : ''
    // Ciclo manual hasta «lista para probar».
    for (const status of ['pending_review', 'approved', 'in_development', 'ready_for_testing'] as const) {
      await capabilities.changeStatus(capabilityId, status, 'admin-it')
    }
  })

  afterAll(async () => {
    await db?.dropDatabase()
    await client?.close()
  })

  it('stores phrases by role and rejects unknown tools', async () => {
    await tests.addPhrase(capabilityId, { text: '¿Cuántos pedidos tengo pendientes?', role: 'validation', expectedStatus: 'supported', expectedTool: 'orders.count', critical: true }, 'admin-it')
    await tests.addPhrase(capabilityId, { text: 'cuántos pedidos hay pendientes', role: 'test', expectedStatus: 'supported', expectedTool: 'orders.count', critical: false }, 'admin-it')
    await tests.addPhrase(capabilityId, { text: 'frase solo para el banco', role: 'control', expectedStatus: 'supported', expectedTool: 'orders.count', critical: false }, 'admin-it')
    await expect(tests.addPhrase(capabilityId, { text: 'x', role: 'test', expectedStatus: 'supported', expectedTool: 'db.drop', critical: false }, 'admin-it')).rejects.toThrow()
    expect((await tests.listPhrases(capabilityId)).map((p) => p.role)).toEqual(['validation', 'test', 'control'])
  })

  it('runs the battery end to end with real data and validates the capability', async () => {
    const { run, completion } = await tests.startRun(capabilityId, { kind: 'battery', forceSelector: false }, tester)
    expect((await capabilities.get(capabilityId)).capability.status).toBe('testing')
    await completion
    const done = await tests.getRun(capabilityId, run.id)
    expect(done.status).toBe('done')
    expect(done.results).toHaveLength(2)
    expect(done.results[0]).toMatchObject({
      role: 'validation',
      passed: true,
      actual: { status: 'supported', tool: 'orders.count', reply: 'tools' },
      trace: { stage: 'rules' },
    })
    expect(done.results[0]!.executions[0]).toMatchObject({ tool: 'orders.count', denied: false, error: null })
    // Sin datos personales en lo guardado: la herramienta solo cuenta pedidos.
    expect(JSON.stringify(done)).not.toMatch(/Ana|example\.com/)
    expect(done.summary).toMatchObject({ batteryPassed: true, validation: { total: 1, passed: 1 } })
    const capability = (await capabilities.get(capabilityId)).capability
    expect(capability.status).toBe('validated')
    expect(capability.lastTest).toMatchObject({ runId: run.id, passed: true, validationAccuracy: 1 })
    // Nada de la prueba se registró como petición de capacidad.
    expect(await db.collection('lumi_capability_requests').countDocuments()).toBe(1)
  })

  it('without permission the tool is not executed and the battery fails', async () => {
    const { run, completion } = await tests.startRun(capabilityId, { kind: 'battery', forceSelector: false }, { userId: 'u2', permissionKeys: [P.LUMI_USE] })
    await completion
    const done = await tests.getRun(capabilityId, run.id)
    expect(done.results[0]!.executions[0]).toMatchObject({ tool: 'orders.count', denied: true, rows: null })
    // El estado sigue siendo «supported» (la herramienta existe); lo que cambia es que no se leyeron datos.
    expect((await tests.listRuns(capabilityId)).map((r) => r.status)).toEqual(['done', 'done'])
    expect((await tests.listRuns(capabilityId))[0]).not.toHaveProperty('results')
  })

  it('moves phrases with a merge and creates the TTL index', async () => {
    const other = await capabilities.recordMissing({ userId: 'u3', conversationId: null, message: 'exporta los pedidos a excel', need: 'exportar pedidos', module: 'pedidos' })
    const otherId = other.recorded ? other.capabilityId : ''
    await tests.addPhrase(otherId, { text: 'exporta los pedidos', role: 'test', expectedStatus: 'missing_capability', expectedTool: null, critical: false }, 'admin-it')
    await capabilities.merge(otherId, capabilityId, 'admin-it')
    expect((await tests.listPhrases(capabilityId)).map((p) => p.text)).toContain('exporta los pedidos')
    const indexes = await db.collection('lumi_capability_test_runs').indexes()
    expect(indexes.find((i) => i.name === 'lumi_capability_test_runs_ttl')?.expireAfterSeconds).toBe(90 * 24 * 60 * 60)
  })
})

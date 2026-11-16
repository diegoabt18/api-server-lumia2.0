/**
 * Fase E de Lumi: registro de herramientas, activación y la primera capacidad real («productos sin
 * precio») contra un MongoDB real y desechable.
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
import { CapabilityActivationService } from '../../src/modules/lumi/capabilities/services/capability-activation.service.js'
import { CapabilityTestService } from '../../src/modules/lumi/capabilities/services/capability-test.service.js'
import { LumiCapabilityService } from '../../src/modules/lumi/capabilities/services/capability.service.js'
import { SandboxTurnRunner } from '../../src/modules/lumi/capabilities/services/sandbox-runner.js'
import { LumiToolGate } from '../../src/modules/lumi/capabilities/services/tool-gate.js'
import { LumiInitiativeRepository } from '../../src/modules/lumi/initiatives/infrastructure/lumi-initiative.repository.js'
import { LumiInitiativeService } from '../../src/modules/lumi/initiatives/services/initiative.service.js'
import { LUMI_TOOLS, matchTool } from '../../src/modules/lumi/tools/catalog.js'
import { createLumiToolDeps } from '../../src/modules/lumi/tools/tool-adapters.js'

const uri = process.env.MONGO_TEST_URI
const describeIfDb = uri ? describe : describe.skip

describeIfDb('Lumi fase E: activación (MongoDB real)', () => {
  let client: MongoClient
  let db: Db
  let repo: LumiCapabilityRepository
  let gate: LumiToolGate
  let activation: CapabilityActivationService
  let capabilities: LumiCapabilityService
  let tests: CapabilityTestService
  const admin = { userId: 'admin-it', permissionKeys: [P.LUMI_USE, P.PRODUCTS_READ] }

  beforeAll(async () => {
    client = await new MongoClient(uri!).connect()
    db = client.db(`lumi_activation_it_${Date.now()}`)
    repo = new LumiCapabilityRepository(db)
    await repo.ensureIndexes()
    const testRepo = new LumiCapabilityTestRepository(db)
    await testRepo.ensureIndexes()
    gate = new LumiToolGate(() => repo.enabledToolNames(), [])
    activation = new CapabilityActivationService(repo, LUMI_TOOLS, gate)
    capabilities = new LumiCapabilityService(repo, undefined, undefined, testRepo)
    const runner = new SandboxTurnRunner({
      select: null,
      selectorEnabled: false,
      enabledTools: () => gate.enabledTools(),
      toolDeps: createLumiToolDeps({
        orders: new OrderRepository(db),
        products: new ProductRepository(db),
        notifications: new NotificationRepository(db),
        initiatives: new LumiInitiativeService(new LumiInitiativeRepository(db)),
      }),
      timezone: 'America/Bogota',
    })
    tests = new CapabilityTestService(repo, testRepo, runner)

    // Catálogo: una vela con precio, otra con precio 0 y un kit sin variantes.
    await db.collection('products').insertMany([
      { _id: new ObjectId(), slug: 'vela-ok', name: 'Vela Con Precio', status: 'active' },
      { _id: new ObjectId(), slug: 'vela-cero', name: 'Vela Precio Cero', status: 'active' },
      { _id: new ObjectId(), slug: 'kit-nuevo', name: 'Kit Nuevo', status: 'draft' },
    ])
    await db.collection('variants').insertMany([
      { sku: 'OK-1', product_slug: 'vela-ok', price: 45000 },
      { sku: 'CERO-1', product_slug: 'vela-cero', price: 0 },
      { sku: 'CERO-2', product_slug: 'vela-cero', price: null },
    ])
  })

  afterAll(async () => {
    await db?.dropDatabase()
    await client?.close()
  })

  it('findUnpriced devuelve los productos sin ninguna variante con precio', async () => {
    const { items, total } = await new ProductRepository(db).findUnpriced(10)
    expect(total).toBe(2)
    expect(items.map((i) => i.name)).toEqual(['Kit Nuevo', 'Vela Precio Cero'])
    expect(items[0]).toMatchObject({ status: 'draft', variantCount: 0 })
  })

  it('findUntaxed: sin tasa numérica cuenta; 0 % es una tasa configurada', async () => {
    const repo = new ProductRepository(db)
    await db.collection('products').updateOne({ slug: 'vela-ok' }, { $set: { tax_rate: 19 } })
    await db.collection('products').updateOne({ slug: 'vela-cero' }, { $set: { tax_rate: 0 } })
    await db.collection('products').updateOne({ slug: 'kit-nuevo' }, { $set: { tax_rate: null } })
    await db.collection('products').insertMany([
      { _id: new ObjectId(), slug: 'jabon-sin-campo', name: 'Jabón Sin Campo', status: 'active' },
      { _id: new ObjectId(), slug: 'difusor-texto', name: 'Difusor Texto', status: 'inactive', tax_rate: '19' },
    ])
    const { items, total } = await repo.findUntaxed(10)
    expect(total).toBe(3)
    expect(items.map((i) => i.name)).toEqual(['Difusor Texto', 'Jabón Sin Campo', 'Kit Nuevo'])
    expect(items[0]).toMatchObject({ status: 'inactive' })
    expect((await repo.findUntaxed(1)).items).toHaveLength(1)
    // Deja el catálogo como estaba: las pruebas siguientes cuentan productos sin precio.
    await db.collection('products').deleteMany({ slug: { $in: ['jabon-sin-campo', 'difusor-texto'] } })
  })

  it('sincroniza el registro una sola vez y solo habilita las 8 herramientas anteriores', async () => {
    await activation.syncRegistry()
    await activation.syncRegistry()
    expect(await db.collection('lumi_capabilities').countDocuments()).toBe(LUMI_TOOLS.length)
    const enabled = await repo.enabledToolNames()
    expect(enabled).toHaveLength(8)
    expect(enabled).not.toContain('products.unpriced')
    expect(matchTool('productos sin precio', admin.permissionKeys, { now: new Date(), timezone: 'America/Bogota', enabled: await gate.enabledTools() })?.tool.name).not.toBe('products.unpriced')
  })

  it('ciclo completo: lista para probar → batería → validada → habilitada → el chat la usa → deshabilitada', async () => {
    const cap = (await capabilities.list({ search: 'precio', sort: 'recent', page: 1, limit: 20 })).items.find((c) => c.toolName === 'products.unpriced')!
    expect(cap.status).toBe('ready_for_testing')
    await tests.addPhrase(cap.id, { text: '¿Qué productos no tienen precio?', role: 'validation', expectedStatus: 'supported', expectedTool: 'products.unpriced', critical: true }, 'admin-it')
    const { run, completion } = await tests.startRun(cap.id, { kind: 'battery', forceSelector: false }, admin)
    await completion
    const done = await tests.getRun(cap.id, run.id)
    // Se probó aunque está deshabilitada: el entorno de pruebas incluye la herramienta en evaluación.
    expect(done.results[0]).toMatchObject({ passed: true, actual: { tool: 'products.unpriced' } })
    expect(done.results[0]!.executions[0]).toMatchObject({ rows: 2 })
    expect((await activation.checks(cap.id, true)).canEnable).toBe(true)

    await activation.enable(cap.id, 'admin-it')
    const enabled = await gate.enabledTools()
    expect(enabled.has('products.unpriced')).toBe(true)
    expect(matchTool('productos sin precio', admin.permissionKeys, { now: new Date(), timezone: 'America/Bogota', enabled })?.tool.name).toBe('products.unpriced')

    await activation.disable(cap.id, 'admin-it')
    expect((await gate.enabledTools()).has('products.unpriced')).toBe(false)
    const history = (await capabilities.get(cap.id)).capability.history.map((h) => h.action)
    expect(history).toEqual(['implemented', 'status', 'tested', 'status', 'status', 'status'])
  })

  it('una capacidad con herramienta no se puede fusionar en otra', async () => {
    const withTool = (await capabilities.list({ search: 'precio', sort: 'recent', page: 1, limit: 20 })).items.find((c) => c.toolName === 'products.unpriced')!
    const other = (await capabilities.list({ sort: 'recent', page: 1, limit: 50 })).items.find((c) => c.id !== withTool.id)!
    await expect(capabilities.merge(withTool.id, other.id, 'admin-it')).rejects.toThrow(/ya tiene herramienta/)
  })
})

/**
 * Fase 3 de Lumi: consultas nuevas del catálogo de herramientas, confirmaciones pendientes y filtro de
 * iniciativas por permisos, contra un MongoDB real y desechable.
 *
 *   MONGO_TEST_URI=mongodb://127.0.0.1:27018 npm run test:integration
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoClient, ObjectId, type Db } from 'mongodb'
import { PERMISSION_REGISTRY as P } from '../../src/common/permissions/registry.js'
import { ProductRepository } from '../../src/modules/catalog/infrastructure/product.repository.js'
import { NotificationRepository } from '../../src/modules/notifications/infrastructure/notification.repository.js'
import { OrderRepository } from '../../src/modules/sales/infrastructure/order.repository.js'
import { MongoPendingActions } from '../../src/modules/lumi/actions/pending-action.js'
import { LumiInitiativeRepository } from '../../src/modules/lumi/initiatives/infrastructure/lumi-initiative.repository.js'
import { LumiInitiativeService } from '../../src/modules/lumi/initiatives/services/initiative.service.js'
import { matchTool, runTool } from '../../src/modules/lumi/tools/catalog.js'
import { MongoActiveEntities } from '../../src/modules/lumi/selector/active-entity.js'
import { interpret, normalizeProposal } from '../../src/modules/lumi/selector/lumi-selector.js'
import { createLumiToolDeps } from '../../src/modules/lumi/tools/tool-adapters.js'

const uri = process.env.MONGO_TEST_URI
const describeIfDb = uri ? describe : describe.skip

describeIfDb('Lumi fase 3 (MongoDB real)', () => {
  let client: MongoClient
  let db: Db
  let orders: OrderRepository
  let products: ProductRepository
  let notifications: NotificationRepository
  let pending: MongoPendingActions
  let initiatives: LumiInitiativeRepository
  const NOW = new Date()
  const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000)

  beforeAll(async () => {
    client = await new MongoClient(uri!).connect()
    db = client.db(`lumi_tools_it_${Date.now()}`)
    orders = new OrderRepository(db)
    products = new ProductRepository(db)
    notifications = new NotificationRepository(db)
    pending = new MongoPendingActions(db)
    await pending.ensureIndexes()
    initiatives = new LumiInitiativeRepository(db)
    await initiatives.ensureIndexes()

    await db.collection('orders').insertMany([
      {
        _id: new ObjectId(), orderNumber: 'ORD-20261114-100000-CB07203E', customerReference: 'ORD-CB07203E',
        status: 'paid', paymentStatus: 'paid', total: 50000, createdAt: hoursAgo(1),
        items: [{ productSlug: 'vela-ambar', quantity: 2, subtotal: 50000 }],
        customerName: 'Ana Pérez', email: 'ana@example.com', phone: '3000000000',
      },
      {
        _id: new ObjectId(), orderNumber: 'ORD-20261113-090000-AA11BB22', customerReference: 'ORD-AA11BB22',
        status: 'pending', paymentStatus: 'pending', total: 20000, createdAt: hoursAgo(30), items: [],
        customerName: 'CB07 Cliente', email: 'cb07@example.com',
      },
      {
        _id: new ObjectId(), orderNumber: 'ORD-20261001-090000-DD33EE44', customerReference: 'ORD-DD33EE44',
        status: 'delivered', paymentStatus: 'paid', total: 70000, createdAt: hoursAgo(24 * 40), items: [],
      },
    ])
    await db.collection('products').insertMany([
      { _id: new ObjectId(), slug: 'vela-ambar', name: 'Vela Vainilla Ámbar', status: 'active' },
      { _id: new ObjectId(), slug: 'difusor-citrico', name: 'Difusor (Cítrico)', status: 'active' },
      { _id: new ObjectId(), slug: 'vela-vieja', name: 'Vela Vieja', status: 'inactive' },
    ])
    await db.collection('variants').insertMany([
      { product_slug: 'vela-ambar', sku: 'VA-S', price: 45000 },
      { product_slug: 'vela-ambar', sku: 'VA-L', price: 52000 },
      { product_slug: 'difusor-citrico', sku: 'DC-1', price: 30000 },
    ])
    await db.collection('inventory_items').insertMany([
      { sku: 'VA-S', quantity: 3, reserved: 1 },
      { sku: 'VA-L', quantity: 5, reserved: 0 },
      { sku: 'DC-1', quantity: 1, reserved: 1 },
    ])
    await db.collection('notifications').insertMany([
      { _id: new ObjectId(), userId: 'u1', type: 'lumi_automation', title: 'Antigua', message: 'x', read: false, createdAt: hoursAgo(5) },
      { _id: new ObjectId(), userId: 'u1', type: 'lumi_automation', title: 'Reciente', message: 'x', read: false, createdAt: hoursAgo(1) },
      { _id: new ObjectId(), userId: 'u1', type: 'lumi_automation', title: 'Leída', message: 'x', read: true, createdAt: hoursAgo(0.5) },
      { _id: new ObjectId(), userId: 'u2', type: 'lumi_automation', title: 'De otro', message: 'x', read: false, createdAt: hoursAgo(0.5) },
    ])
  })

  afterAll(async () => {
    await db?.dropDatabase()
    await client?.close()
  })

  describe('pedidos', () => {
    it('busca por referencia corta, por sufijo y por prefijo del número interno', async () => {
      expect((await orders.findByReference('ORD-CB07203E', 3)).map((o) => o.customerReference)).toEqual(['ORD-CB07203E'])
      expect((await orders.findByReference('cb07203e', 3)).map((o) => o.customerReference)).toEqual(['ORD-CB07203E'])
      expect((await orders.findByReference('ORD-20261113', 3)).map((o) => o.customerReference)).toEqual(['ORD-AA11BB22'])
    })

    it('nunca busca por nombre, correo ni teléfono del cliente', async () => {
      expect(await orders.findByReference('CB07 Cliente', 3)).toEqual([])
      expect(await orders.findByReference('ana@example.com', 3)).toEqual([])
      expect(await orders.findByReference('3000000000', 3)).toEqual([])
    })

    it('cuenta por estado, en total y dentro de un rango', async () => {
      expect(await orders.countByStatus()).toEqual({ paid: 1, pending: 1, delivered: 1 })
      expect(await orders.countByStatus({ from: hoursAgo(48), to: NOW })).toEqual({ paid: 1, pending: 1 })
    })
  })

  describe('productos', () => {
    const search = async (query: string, extra: Record<string, unknown> = {}) =>
      (await products.searchProducts({ query, pageSize: 5, ...extra })).items

    it('busca sin distinguir tildes y calcula disponible y precios', async () => {
      expect(await search('ambar')).toEqual([
        {
          id: expect.any(String), slug: 'vela-ambar', name: 'Vela Vainilla Ámbar', status: 'active', categorySlug: null,
          available: 7, minPrice: 45000, maxPrice: 52000, variantCount: 2,
        },
      ])
    })

    it('escapa los caracteres especiales de la búsqueda', async () => {
      expect((await search('(cítrico)')).map((p) => p.name)).toEqual(['Difusor (Cítrico)'])
      expect(await search('.*')).toEqual([])
    })

    it('muestra los inactivos marcados como tales (el administrador puede verlos)', async () => {
      expect((await search('vieja'))[0]).toMatchObject({ status: 'inactive', available: 0 })
    })

    it('modo exact: el nombre completo, sin tildes ni mayúsculas; un fragmento no basta', async () => {
      expect((await search('vela vainilla ambar', { mode: 'exact' })).map((p) => p.slug)).toEqual(['vela-ambar'])
      expect(await search('vela', { mode: 'exact' })).toEqual([])
    })

    it('pagina con orden estable y total, y filtra por estado', async () => {
      const page1 = await products.searchProducts({ query: 'vel', pageSize: 1, page: 1 })
      const page2 = await products.searchProducts({ query: 'vel', pageSize: 1, page: 2 })
      expect(page1.total).toBe(2)
      expect([page1.items[0]!.name, page2.items[0]!.name]).toEqual(['Vela Vainilla Ámbar', 'Vela Vieja'])
      expect((await search('vel', { status: 'inactive' })).map((p) => p.slug)).toEqual(['vela-vieja'])
    })

    it('sin texto no devuelve el catálogo', async () => {
      expect(await products.searchProducts({ query: '   ' })).toMatchObject({ items: [], total: 0 })
    })
  })

  describe('búsqueda común en las cuatro superficies (tienda, panel, POS, Lumi)', () => {
    it('la tienda encuentra sin tildes y solo productos activos', async () => {
      const found = await products.findActivePaged(10, 0, 'ambar')
      expect(found.map((p) => p.slug)).toEqual(['vela-ambar'])
    })

    it('el panel encuentra palabra por palabra, incluidos inactivos', async () => {
      expect((await products.listAdmin(10, 0, 'vainilla vela')).map((p) => p.slug)).toEqual(['vela-ambar'])
      expect((await products.listAdmin(10, 0, 'vieja')).map((p) => p.slug)).toEqual(['vela-vieja'])
      expect(await products.countAllAdmin('vainilla vela')).toBe(1)
    })

    it('el POS encuentra por nombre sin tildes y por SKU de la variante', async () => {
      expect((await products.searchForPos('citrico', 1, 10)).items.map((p) => p.slug)).toEqual(['difusor-citrico'])
      expect((await products.searchForPos('va-l', 1, 10)).items.map((p) => p.slug)).toEqual(['vela-ambar'])
    })
  })

  describe('notificaciones', () => {
    it('las sin leer del propio usuario, más recientes primero', async () => {
      expect((await notifications.recentUnread('u1', 5)).map((n) => n.title)).toEqual(['Reciente', 'Antigua'])
      expect(await notifications.countUnread('u1')).toBe(2)
    })
  })

  describe('acciones pendientes de confirmación', () => {
    const base = (expiresAt: Date) => ({
      userId: 'u1',
      kind: 'delete_routine' as const,
      payload: { taskId: 't1' },
      summary: 'Eliminar «Rutina»',
      createdAt: NOW,
      expiresAt,
    })

    it('una nueva sustituye a la anterior y solo se consume una vez, aunque lleguen dos confirmaciones a la vez', async () => {
      await pending.put(base(new Date(NOW.getTime() + 60_000)))
      await pending.put({ ...base(new Date(NOW.getTime() + 60_000)), payload: { taskId: 't2' } })
      expect(await db.collection('lumi_pending_actions').countDocuments({ userId: 'u1' })).toBe(1)
      const [a, b] = await Promise.all([pending.take('u1', 'delete_routine', NOW), pending.take('u1', 'delete_routine', NOW)])
      const taken = [a, b].filter(Boolean)
      expect(taken).toHaveLength(1)
      expect(taken[0]!.payload.taskId).toBe('t2')
    })

    it('una acción caducada no se ejecuta', async () => {
      await pending.put(base(new Date(NOW.getTime() - 1)))
      expect(await pending.hasPending('u1', NOW)).toBe(false)
      expect(await pending.take('u1', 'delete_routine', NOW)).toBeNull()
    })

    it('descartar borra solo las del usuario', async () => {
      await pending.put(base(new Date(NOW.getTime() + 60_000)))
      await pending.put({ ...base(new Date(NOW.getTime() + 60_000)), userId: 'u2' })
      expect(await pending.discard('u1', NOW)).toBe(1)
      expect(await pending.hasPending('u2', NOW)).toBe(true)
    })
  })

  describe('iniciativas por permisos', () => {
    it('el listado del servicio solo devuelve los tipos que el usuario puede ver', async () => {
      const common = { openCount: 1, firstSeenAt: NOW, lastSeenAt: NOW, stateChangedAt: NOW, state: 'nueva' as const, userId: 'u1' }
      await initiatives.insert({ ...common, kind: 'stock', subjectKey: 'a', dedupKey: 'stock:a', title: 'S', detail: 'd', priority: 3 })
      await initiatives.insert({ ...common, kind: 'order_attention', subjectKey: 'o', dedupKey: 'order_attention:o', title: 'O', detail: 'd', priority: 2 })
      const service = new LumiInitiativeService(initiatives)
      expect((await service.list('u1', [P.LUMI_USE, P.INVENTORY_READ], { limit: 10 })).map((i) => i.kind)).toEqual(['stock'])
      expect((await service.list('u1', [P.LUMI_USE], { limit: 10 })).map((i) => i.kind)).toEqual([])
      expect((await service.list('u1', ['*' as never], { limit: 10 })).length).toBe(2)
    })
  })

  describe('catálogo completo sobre Mongo', () => {
    it('"¿Cuánto stock queda de la vela ambar?" responde con datos reales', async () => {
      const deps = createLumiToolDeps({ orders, products, notifications, initiatives: new LumiInitiativeService(initiatives) })
      const keys = [P.LUMI_USE, P.PRODUCTS_READ, P.INVENTORY_READ, P.ORDERS_READ, P.ANALYTICS_READ]
      const ctx = { userId: 'u1', permissionKeys: keys, now: NOW, timezone: 'America/Bogota', deps }
      const stock = matchTool('¿Cuánto stock queda de la vela ambar?', keys, ctx)!
      expect((await runTool(stock, ctx)).text).toContain('- Vela Vainilla Ámbar: 7 disponibles · $45.000–$52.000')
      const lookup = matchTool('¿Cómo va el pedido ORD-CB07203E?', keys, ctx)!
      const text = (await runTool(lookup, ctx)).text
      expect(text).toContain('- Estado: pagado, por despachar')
      expect(text).toContain('- Artículos: 2')
      expect(text).not.toMatch(/Ana|example|3000000000/)
    })
  })

  describe('selector (fase A2) y entidad activa', () => {
    it('"¿qué productos contiene?" con el pedido de la respuesta anterior lee ese pedido', async () => {
      const deps = createLumiToolDeps({ orders, products, notifications, initiatives: new LumiInitiativeService(initiatives) })
      const keys = [P.LUMI_USE, P.ORDERS_READ]
      const ctx = { userId: 'u1', permissionKeys: keys, now: NOW, timezone: 'America/Bogota', deps }
      const store = new MongoActiveEntities(db)
      await store.ensureIndexes()

      // Turno 1 (reglas): el pedido queda como entidad activa de la conversación.
      const first = await runTool(matchTool('¿Cómo va el pedido ORD-CB07203E?', keys, ctx)!, ctx)
      expect(first.entity).toEqual({ kind: 'order', label: 'ORD-CB07203E' })
      await store.set('u1', 'conv-1', first.entity!, NOW)

      // Turno 2 (selector): el modelo propone orders.lookup sin referencia; el Server usa la entidad.
      const message = '¿y qué productos contiene?'
      const entity = await store.get('u1', 'conv-1', NOW)
      const proposal = { status: 'tool' as const, intents: [{ tool: 'orders.lookup', args: {} }], need: '', module: 'pedidos' }
      const result = interpret(message, normalizeProposal(message, proposal, entity), keys, ctx)
      expect(result.status).toBe('supported')
      const text = (await runTool((result as { matches: Parameters<typeof runTool>[0][] }).matches[0]!, ctx)).text
      expect(text).toContain('Pedido ORD-CB07203E')
      expect(text).not.toMatch(/Ana|example/)

      // Otra conversación u otro usuario no ven esa entidad; caduca sola.
      expect(await store.get('u2', 'conv-1', NOW)).toBeNull()
      expect(await store.get('u1', 'conv-2', NOW)).toBeNull()
      expect(await store.get('u1', 'conv-1', new Date(NOW.getTime() + 31 * 60_000))).toBeNull()
      const indexes = await db.collection('lumi_context').indexes()
      expect(indexes.map((i) => i.name)).toEqual(expect.arrayContaining(['lumi_context_ttl', 'lumi_context_user_conversation']))
    })
  })
})

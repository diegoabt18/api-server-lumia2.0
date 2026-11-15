import { MongoClient, ObjectId } from 'mongodb'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'

const env = inject('e2e')
const ADMIN = env.urls.admin
const SERVER = env.urls.server

/** Cliente HTTP con su propio "navegador" (cookies) para hablar con el BFF o con el Server. */
let browsers = 0

class Client {
  private cookies = new Map<string, string>()
  /** Cada cliente es un navegador distinto, salvo que se indique el mismo User-Agent. */
  constructor(
    private readonly base: string,
    private readonly origin?: string,
    readonly userAgent = `Mozilla/5.0 (E2E navegador ${++browsers})`,
  ) {}

  async request(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; json: any; headers: Headers }> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        'User-Agent': this.userAgent,
        'Accept-Language': 'es-CO',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(this.origin && method !== 'GET' ? { Origin: this.origin } : {}),
        ...(this.cookies.size ? { Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    })
    for (const raw of res.headers.getSetCookie()) {
      const [pair] = raw.split(';')
      const eq = pair!.indexOf('=')
      const name = pair!.slice(0, eq).trim()
      const value = pair!.slice(eq + 1).trim()
      if (!value || /max-age=0/i.test(raw)) this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
    const text = await res.text()
    let json: any = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = text
    }
    return { status: res.status, json, headers: res.headers }
  }

  get = (p: string, h?: Record<string, string>) => this.request('GET', p, undefined, h)
  post = (p: string, b?: unknown, h?: Record<string, string>) => this.request('POST', p, b ?? {}, h)
  patch = (p: string, b: unknown) => this.request('PATCH', p, b)
  put = (p: string, b: unknown) => this.request('PUT', p, b)

  cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
  }
}

const bff = () => new Client(ADMIN, ADMIN)
const api = () => new Client(SERVER)

async function loginBff(email: string, password: string) {
  const c = bff()
  const res = await c.post('/api/auth/login', { email, password })
  expect(res.status, JSON.stringify(res.json)).toBe(200)
  return c
}

async function loginServer(email: string, password: string) {
  const c = api()
  const res = await c.post('/api/auth/login', { email, password })
  expect(res.status, JSON.stringify(res.json)).toBe(200)
  return c
}

/** La auditoría se escribe al terminar de enviar la respuesta: se espera a que aparezca. */
async function auditEventually(client: Client, query: string, ready: (items: any[]) => boolean) {
  let items: any[] = []
  for (let i = 0; i < 20; i++) {
    const res = await client.get(`/api/admin/activity-audit?${query}`)
    items = res.json?.items ?? []
    if (ready(items)) return items
    await new Promise((r) => setTimeout(r, 100))
  }
  return items
}

/** Último cuerpo que recibió el Ollama simulado (prompt completo enviado al modelo). */
async function ollamaLast(): Promise<{ messages: Array<{ role: string; content: string }> } | null> {
  return ((await (await fetch(`${env.urls.ollama}/__last`)).json()) as { last: any }).last
}

/** Turno de chat por el stream del BFF, como el navegador. Devuelve los eventos SSE ya parseados. */
async function chatStream(client: Client, message: string): Promise<Array<{ event: string; data: any }>> {
  const res = await fetch(`${ADMIN}/api/admin/lumi/chat/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Origin: ADMIN,
      'User-Agent': client.userAgent,
      'Accept-Language': 'es-CO',
      Cookie: client.cookieHeader(),
    },
    body: JSON.stringify({ message }),
  })
  expect(res.status, await res.clone().text()).toBe(200)
  const text = await res.text()
  return text
    .split('\n\n')
    .filter((b) => b.trim())
    .map((block) => {
      const event = /^event: (.+)$/m.exec(block)?.[1] ?? ''
      const data = /^data: (.+)$/m.exec(block)?.[1] ?? 'null'
      return { event, data: JSON.parse(data) }
    })
}

const answerOf = (events: Array<{ event: string; data: any }>) =>
  events.filter((e) => e.event === 'token').map((e) => e.data.text).join('')

async function ollamaCalls(): Promise<number> {
  return ((await (await fetch(`${env.urls.ollama}/__calls`)).json()) as { calls: number }).calls
}

let mongo: MongoClient
let admin: Client
let adminApi: Client

beforeAll(async () => {
  mongo = new MongoClient(env.mongoUri)
  await mongo.connect()
  admin = await loginBff('admin@e2e.test', env.passwords.admin)
  adminApi = await loginServer('admin@e2e.test', env.passwords.admin)
})

afterAll(async () => {
  await mongo?.close()
})

describe('1. Autenticación y sesión (Admin BFF → Server)', () => {
  it('los tres servicios responden', async () => {
    expect((await bff().get('/api/health')).status).toBe(200)
    expect((await api().get('/health/ready')).json.status).toBe('ready')
    expect((await fetch(`${env.urls.ia}/api/v1/health`)).status).toBe(200)
  })

  it('el BFF guarda la sesión en cookies propias HttpOnly y nunca entrega los tokens del Server', async () => {
    const c = bff()
    const res = await c.post('/api/auth/login', { email: 'admin@e2e.test', password: env.passwords.admin })
    const setCookies = res.headers.getSetCookie().join('\n')
    expect(setCookies).toMatch(/lumia_admin_at=.*HttpOnly/i)
    expect(setCookies).toMatch(/SameSite=Strict/i)
    expect(setCookies).not.toMatch(/lumia_access=|lumia_refresh=/)
    expect(JSON.stringify(res.json)).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\./) // ningún JWT en el cuerpo
  })

  it('la sesión expone permisos efectivos del Server', async () => {
    const res = await admin.get('/api/session')
    expect(res.status).toBe(200)
    expect(res.json.permissions).toContain('admin.access')
  })

  it('CSRF: una escritura sin Origin permitido se rechaza en el BFF', async () => {
    const c = new Client(ADMIN, 'https://evil.example')
    const res = await c.post('/api/auth/login', { email: 'admin@e2e.test', password: 'x'.repeat(10) })
    expect(res.status).toBe(403)
    expect(res.json.data?.code ?? res.json.statusMessage).toMatch(/FORBIDDEN_ORIGIN/)
  })

  it('fuerza bruta: la cuenta se bloquea (429) tras los intentos fallidos, también vía BFF', async () => {
    const statuses: number[] = []
    for (let i = 0; i < 4; i++) {
      statuses.push((await bff().post('/api/auth/login', { email: 'locked@e2e.test', password: 'incorrecta-123' })).status)
    }
    expect(statuses.slice(0, 3)).toEqual([401, 401, 401])
    expect(statuses[3]).toBe(429)
    // Ni siquiera la contraseña correcta entra durante el bloqueo.
    const correct = await bff().post('/api/auth/login', { email: 'locked@e2e.test', password: env.passwords.locked })
    expect(correct.status).toBe(429)
  })

  it('entrar en el admin no cierra la sesión de la tienda en el mismo navegador', async () => {
    const ua = 'Mozilla/5.0 (E2E mismo navegador)'
    const store = new Client(SERVER, undefined, ua)
    expect((await store.post('/api/auth/login', { email: 'admin@e2e.test', password: env.passwords.admin })).status).toBe(200)
    const adminTab = new Client(ADMIN, ADMIN, ua)
    expect((await adminTab.post('/api/auth/login', { email: 'admin@e2e.test', password: env.passwords.admin })).status).toBe(200)
    expect((await store.get('/api/auth/me')).status).toBe(200)
    expect((await adminTab.get('/api/session')).status).toBe(200)
    // En cambio, un segundo login en la misma aplicación y navegador sí reemplaza la sesión anterior.
    const store2 = new Client(SERVER, undefined, ua)
    expect((await store2.post('/api/auth/login', { email: 'admin@e2e.test', password: env.passwords.admin })).status).toBe(200)
    expect((await store.get('/api/auth/me')).status).toBe(401)
  })

  it('sin sesión, el BFF responde 401 y el Server también', async () => {
    expect((await bff().get('/api/admin/products')).status).toBe(401)
    expect((await api().get('/api/admin/products')).status).toBe(401)
  })
})

describe('2. Permisos y escalada de privilegios', () => {
  it('sin permiso, el Server rechaza la operación aunque el usuario tenga sesión de admin', async () => {
    const limited = await loginBff('limited@e2e.test', env.passwords.limited)
    const res = await limited.post('/api/admin/categories', { name: 'No permitida', slug: 'no-permitida' })
    expect(res.status).toBe(403)
  })

  it('el Server impide asignarse un rol a uno mismo (sin pasar por el BFF)', async () => {
    const limitedApi = await loginServer('limited@e2e.test', env.passwords.limited)
    const res = await limitedApi.post(`/api/admin/security/users/${env.userIds.limited}/roles`, { roleId: env.roleIds.super })
    expect(res.status).toBe(403)
    expect(res.json.code).toBe('SELF_PERMISSION_CHANGE')
  })

  it('el Server impide conceder a otro un rol con permisos que no se tienen', async () => {
    const limitedApi = await loginServer('limited@e2e.test', env.passwords.limited)
    const res = await limitedApi.post(`/api/admin/security/users/${env.userIds.locked}/roles`, { roleId: env.roleIds.super })
    expect(res.status).toBe(403)
    expect(res.json.code).toBe('PRIVILEGE_ESCALATION')
  })
})

describe('3. Operaciones administrativas y auditoría', () => {
  const ctx: { categoryId?: string; subcategoryId?: string; productId?: string } = {}
  const sku = `E2E-${Date.now()}`

  it('crea categoría, subcategoría, producto, variante y stock a través del BFF', async () => {
    const cat = await admin.post('/api/admin/categories', { name: 'Velas E2E', slug: `velas-e2e-${Date.now()}` })
    expect(cat.status, JSON.stringify(cat.json)).toBe(200)
    ctx.categoryId = cat.json.id
    const sub = await admin.post(`/api/admin/categories/${ctx.categoryId}/subcategories`, { name: 'Aromáticas', slug: `aromaticas-${Date.now()}` })
    expect(sub.status, JSON.stringify(sub.json)).toBe(200)
    ctx.subcategoryId = sub.json.id
    const product = await admin.post('/api/admin/products', {
      name: 'Vela de prueba',
      slug: `vela-prueba-${Date.now()}`,
      subcategory_id: ctx.subcategoryId,
      status: 'active',
    })
    expect(product.status, JSON.stringify(product.json)).toBe(200)
    ctx.productId = product.json.id
    const variant = await admin.post(`/api/admin/products/${ctx.productId}/variants`, { sku, price: 45000 })
    expect(variant.status, JSON.stringify(variant.json)).toBe(200)
    const stock = await admin.put(`/api/admin/products/${ctx.productId}/inventory/${sku}`, { quantity: 20 })
    expect(stock.status, JSON.stringify(stock.json)).toBe(200)
    const renamed = await admin.patch(`/api/admin/categories/${ctx.categoryId}`, { name: 'Velas E2E (editada)' })
    expect(renamed.status, JSON.stringify(renamed.json)).toBe(200)
  })

  it('cada operación queda en la auditoría administrativa con actor, IP, recurso y cambios', async () => {
    const items = await auditEventually(adminApi, `resourceType=category&resourceId=${ctx.categoryId}`, (xs) =>
      xs.some((r) => r.action === 'PATCH /api/admin/categories/:id'),
    )
    const patch = items.find((r: any) => r.action === 'PATCH /api/admin/categories/:id')
    expect(patch).toBeTruthy()
    expect(patch.actor.userId).toBe(env.userIds.admin)
    expect(patch.actor.ip).toBe('127.0.0.1')
    expect(patch.result).toBe('success')
    expect(patch.changes?.name).toEqual({ before: 'Velas E2E', after: 'Velas E2E (editada)' })

    const product = await auditEventually(adminApi, `resourceType=product&resourceId=${ctx.productId}`, (xs) => xs.length >= 2)
    const actions = product.map((r: any) => r.action)
    expect(actions).toEqual(
      expect.arrayContaining(['POST /api/admin/products/:id/variants', 'PUT /api/admin/products/:id/inventory/:sku']),
    )
  })

  it('las operaciones denegadas también se registran', async () => {
    const items = await auditEventually(adminApi, `result=denied&actorUserId=${env.userIds.limited}`, (xs) => xs.length >= 2)
    expect(items.some((r: any) => r.action === 'POST /api/admin/categories')).toBe(true)
    expect(items.some((r: any) => r.errorCode === 'SELF_PERMISSION_CHANGE')).toBe(true)
  })

  it('la auditoría nunca guarda contraseñas ni tokens', async () => {
    const all = await mongo.db('identity_db').collection('admin_activity_audit').find().toArray()
    const dump = JSON.stringify(all)
    for (const value of Object.values(env.passwords)) expect(dump).not.toContain(value)
    expect(dump).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\./)
  })

  it('IP del cliente: solo un proxy con el secreto compartido puede declararla', async () => {
    const declared = await adminApi.post(
      `/api/admin/categories`,
      { name: 'IP declarada', slug: `ip-declarada-${Date.now()}` },
      { 'X-Lumia-Client-IP': '203.0.113.50', 'X-Lumia-Proxy-Secret': env.edgeSecret },
    )
    expect(declared.status).toBe(200)
    const forged = await adminApi.post(
      `/api/admin/categories`,
      { name: 'IP falsificada', slug: `ip-falsificada-${Date.now()}` },
      { 'X-Lumia-Client-IP': '198.51.100.66', 'X-Lumia-Proxy-Secret': 'no-es-el-secreto-'.repeat(3) },
    )
    expect(forged.status).toBe(200)
    const log = await auditEventually(adminApi, 'resourceType=categories&limit=10', (xs) =>
      xs.filter((r) => r.action === 'POST /api/admin/categories').length >= 3,
    )
    const ips = log.filter((r: any) => r.action === 'POST /api/admin/categories').map((r: any) => r.actor.ip)
    expect(ips).toContain('203.0.113.50')
    expect(ips).not.toContain('198.51.100.66')
  })

  it('la cadena de auditoría se verifica íntegra', async () => {
    const res = await adminApi.get('/api/admin/activity-audit/verify')
    expect(res.json).toMatchObject({ ok: true })
    expect(res.json.checked).toBeGreaterThan(5)
  })

  describe('4. Pedidos (tienda → Server → Admin)', () => {
    let orderId = ''

    it('un cliente compra: dos envíos simultáneos del checkout crean un solo pedido', async () => {
      const shopper = api()
      const added = await shopper.post('/api/cart/items', { sku, quantity: 2, product: { productSlug: 'x', productName: 'Vela de prueba' } })
      expect(added.status, JSON.stringify(added.json)).toBe(200)
      const checkout = {
        customerName: 'Cliente E2E',
        phone: '3001234567',
        address: 'Calle 1 # 2-3',
        city: 'Bogotá',
        reference: 'Casa blanca',
        email: 'cliente@e2e.test',
      }
      const [a, b] = await Promise.all([shopper.post('/api/orders/create', checkout), shopper.post('/api/orders/create', checkout)])
      const statuses = [a.status, b.status].sort()
      expect(statuses, JSON.stringify([a.json, b.json])).toEqual([200, 409])
      const created = a.status === 200 ? a.json : b.json
      orderId = created.id
      expect(created.total).toBe(90000)
    })

    it('el administrador ve el pedido en el BFF', async () => {
      const res = await admin.get(`/api/admin/orders/${orderId}`)
      expect(res.status, JSON.stringify(res.json)).toBe(200)
      expect(JSON.stringify(res.json)).toContain('Cliente E2E')
    })

    it('el Server rechaza transiciones de estado inválidas aunque se salte el BFF', async () => {
      const res = await adminApi.patch(`/api/admin/orders/${orderId}`, { status: 'delivered' })
      expect(res.status).toBe(409)
      expect(res.json.code).toBe('INVALID_TRANSITION')
    })

    it('una cancelación válida desde el BFF se aplica y se audita con antes/después', async () => {
      const res = await admin.post(`/api/admin/orders/${orderId}/status`, { status: 'cancelled', cancellationReason: 'Prueba E2E' })
      expect(res.status, JSON.stringify(res.json)).toBe(200)
      const log = await auditEventually(adminApi, `resourceType=order&resourceId=${orderId}`, (xs) =>
        xs.some((r) => r.result === 'success'),
      )
      const change = log.find((r: any) => r.result === 'success')
      expect(change.changes.status).toEqual({ before: 'pending', after: 'cancelled' })
    })
  })
})

describe('5. Notificaciones en tiempo real (Server → SSE → BFF)', () => {
  it('un recordatorio creado desde Lumi llega por el stream del BFF', async () => {
    const controller = new AbortController()
    const res = await fetch(`${ADMIN}/api/notifications/stream`, {
      headers: { Cookie: admin.cookieHeader(), Accept: 'text/event-stream' },
      signal: controller.signal,
    })
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    // Una sola lectura pendiente a la vez: si gana el temporizador, se reutiliza en la siguiente
    // vuelta (descartarla perdería el evento que traiga).
    let pending: ReturnType<typeof reader.read> | null = null
    const waitFor = async (pattern: RegExp, ms: number) => {
      const deadline = Date.now() + ms
      while (Date.now() < deadline) {
        if (pattern.test(buffer)) return true
        pending ??= reader.read()
        const chunk = await Promise.race([
          pending,
          new Promise<null>((r) => setTimeout(() => r(null), 1000)),
        ])
        if (chunk === null) continue
        pending = null
        if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true })
      }
      return pattern.test(buffer)
    }
    expect(await waitFor(/event: ready/, 10_000)).toBe(true)

    const before = await ollamaCalls()
    const chat = await admin.post('/api/admin/lumi/chat', { message: 'Recuérdame hoy a las 23:59 revisar el inventario E2E' })
    expect(chat.status, JSON.stringify(chat.json)).toBe(200)
    expect(await ollamaCalls()).toBe(before) // los recordatorios no usan el modelo

    // "Viaje en el tiempo" sobre la base desechable: la tarea vence ahora.
    const tasks = mongo.db('identity_db').collection('lumi_tasks')
    const task = await tasks.findOne({ userId: env.userIds.admin, title: /inventario E2E/i })
    expect(task, 'la tarea se guardó').toBeTruthy()
    await tasks.updateOne({ _id: task!._id as ObjectId }, { $set: { nextRunAt: new Date(Date.now() - 1000) } })

    expect(await waitFor(/event: notification[\s\S]*inventario E2E/i, 25_000)).toBe(true)
    controller.abort()
  })
})

describe('6. Asistente Lumi (BFF → Server → local-ai-assistant → modelo)', () => {
  it('una pregunta abierta llega al modelo y se guarda la conversación del usuario', async () => {
    const before = await ollamaCalls()
    const res = await admin.post('/api/admin/lumi/chat', { message: 'Hola, ¿en qué me puedes ayudar?' })
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    expect(JSON.stringify(res.json)).toContain('Respuesta de prueba del modelo simulado.')
    expect(await ollamaCalls()).toBe(before + 1)
    const conversations = await admin.get('/api/admin/lumi/conversations')
    expect(conversations.status).toBe(200)
    expect(JSON.stringify(conversations.json)).toContain('Hola')
  })

  it('"últimos pedidos" se resuelve con el backend, sin llamar al modelo', async () => {
    const before = await ollamaCalls()
    const res = await admin.post('/api/admin/lumi/chat', { message: 'Muéstrame los últimos 5 pedidos' })
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    expect(JSON.stringify(res.json)).toMatch(/pedido/i)
    expect(await ollamaCalls()).toBe(before)
  })

  it('sin el permiso lumi.use el Server no deja usar el asistente', async () => {
    const limited = await loginBff('limited@e2e.test', env.passwords.limited)
    const res = await limited.post('/api/admin/lumi/chat', { message: 'hola' })
    expect(res.status).toBe(403)
  })

  it('el asistente no acepta llamadas sin la clave de servicio ni conversaciones ajenas', async () => {
    const noKey = await fetch(`${env.urls.ia}/api/v1/conversations`, { headers: { 'X-User-Ref': env.userIds.admin } })
    expect(noKey.status).toBe(401)
    const other = await fetch(`${env.urls.ia}/api/v1/conversations`, {
      headers: { 'X-API-Key': env.iaKey, 'X-User-Ref': env.userIds.limited },
    })
    expect(((await other.json()) as { items?: unknown[] }).items ?? []).toHaveLength(0)
  })
})

describe('6b. Lumi fase 3: herramientas con datos reales y reglas seguras', () => {
  /** Inicio del día de hoy en Bogotá (UTC-5, sin horario de verano). */
  const bogotaDayStart = () => {
    const now = new Date()
    const local = new Date(now.getTime() - 5 * 3_600_000)
    return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 5, 0, 0))
  }

  beforeAll(async () => {
    // Pedidos de prueba con importes reconocibles, creados hoy (los de la sección 4 también cuentan).
    const now = new Date()
    await mongo.db('sales_db').collection('orders').insertMany([
      {
        _id: new ObjectId(), orderNumber: 'ORD-20991231-000000-E2E0F301', customerReference: 'ORD-E2E0F301',
        status: 'paid', paymentStatus: 'paid', total: 123457, createdAt: now, updatedAt: now,
        items: [{ productSlug: 'e2e-fase3', productName: 'Vela Fase Tres', quantity: 3, subtotal: 123457 }],
        customerName: 'Cliente Privado Fase3', email: 'privado-fase3@e2e.test', phone: '3110000000',
      },
      {
        _id: new ObjectId(), orderNumber: 'ORD-20991231-000001-E2E0F302', customerReference: 'ORD-E2E0F302',
        status: 'pending', paymentStatus: 'pending', total: 5000, createdAt: now, updatedAt: now, items: [],
      },
    ])
  })

  it('"¿Cómo va el pedido …?" responde con datos reales, sin modelo y sin datos del cliente', async () => {
    const before = await ollamaCalls()
    const events = await chatStream(admin, '¿Cómo va el pedido ORD-E2E0F301?')
    const tool = events.find((e) => e.event === 'tool')
    expect(tool?.data).toMatchObject({ name: 'orders.lookup', rows: 1, denied: false })
    const answer = answerOf(events)
    expect(answer).toContain('Pedido ORD-E2E0F301')
    expect(answer).toContain('- Estado: pagado, por despachar')
    expect(answer).toContain('- Total: $123.457')
    expect(answer).not.toMatch(/Cliente Privado|privado-fase3|3110000000/)
    expect(events.at(-1)?.event).toBe('done')
    expect(await ollamaCalls()).toBe(before)
  })

  it('"¿Cuántos pedidos hubo hoy?" devuelve una cifra que coincide con la base', async () => {
    const orders = mongo.db('sales_db').collection('orders')
    const expected = await orders.countDocuments({ createdAt: { $gte: bogotaDayStart() } })
    const before = await ollamaCalls()
    const answer = answerOf(await chatStream(admin, '¿Cuántos pedidos hubo hoy?'))
    expect(answer).toMatch(new RegExp(`^Pedidos creados hoy: ${expected}\\.`))
    expect(await ollamaCalls()).toBe(before)
  })

  it('"¿Cuánto vendimos hoy?" suma solo pedidos vendidos y coincide con la base', async () => {
    const orders = mongo.db('sales_db').collection('orders')
    const sold = await orders
      .find({ createdAt: { $gte: bogotaDayStart() }, status: { $in: ['paid', 'shipped', 'delivered'] } })
      .toArray()
    const revenue = sold.reduce((sum, o) => sum + (Number(o.total) || 0), 0)
    const answer = answerOf(await chatStream(admin, '¿Cuánto vendimos hoy?'))
    expect(answer).toContain(`Ventas de hoy: $${Math.round(revenue).toLocaleString('es-CO')} en ${sold.length}`)
  })

  it('sin el permiso de analítica no se leen ventas y se avisa', async () => {
    const catalog = await loginBff('catalog@e2e.test', env.passwords.catalog)
    const events = await chatStream(catalog, '¿Cuánto vendimos hoy?')
    expect(events.find((e) => e.event === 'tool')?.data).toMatchObject({ name: 'sales.summary', denied: true, rows: 0 })
    expect(answerOf(events)).toBe('No tienes permiso para consultar ventas ni analítica.')
  })

  it('el modelo recibe la fecha, las capacidades según los permisos y la regla de no confirmar acciones', async () => {
    const catalog = await loginBff('catalog@e2e.test', env.passwords.catalog)
    const before = await ollamaCalls()
    await chatStream(catalog, 'Hola, ¿qué puedes hacer por mí?')
    expect(await ollamaCalls()).toBe(before + 1)
    const system = (await ollamaLast())!.messages[0]!
    expect(system.role).toBe('system')
    expect(system.content).toContain('nunca digas que creaste, programaste')
    expect(system.content).toMatch(/Hoy es [^,\s]+, \d{1,2} de \S+ de \d{4}/)
    expect(system.content).toContain('Productos sin stock')
    expect(system.content).not.toContain('Ventas, pedidos vendidos')
    expect(system.content).not.toContain('estado de un pedido')
  })

  it('"¿Por qué …las ventas…?" consulta los datos y el modelo los recibe como contexto', async () => {
    const before = await ollamaCalls()
    const events = await chatStream(admin, '¿Por qué bajaron las ventas esta semana?')
    expect(events.find((e) => e.event === 'tool')?.data).toMatchObject({ name: 'sales.summary', denied: false })
    expect(await ollamaCalls()).toBe(before + 1)
    const messages = (await ollamaLast())!.messages
    expect(messages.some((m) => m.role === 'system' && m.content.includes('Datos consultados por el sistema'))).toBe(true)
  })

  it('"Cancela la revisión del pedido …" no borra la rutina; borrar exige confirmación', async () => {
    const tasks = mongo.db('identity_db').collection('lumi_tasks')
    const create = await admin.post('/api/admin/lumi/chat', {
      message: 'Todos los días a las 8 de la mañana revisa mis iniciativas pendientes',
    })
    expect(create.status, JSON.stringify(create.json)).toBe(200)
    const routine = await tasks.findOne({ userId: env.userIds.admin, kind: 'initiative_review' })
    expect(routine, 'la rutina existe').toBeTruthy()

    await admin.post('/api/admin/lumi/chat', { message: 'Cancela la revisión del pedido 1234' })
    expect(await tasks.countDocuments({ _id: routine!._id })).toBe(1)

    const ask = await admin.post('/api/admin/lumi/chat', { message: 'Elimina la revisión diaria' })
    expect(ask.json.response).toContain('¿Elimino «Revisar iniciativas pendientes»')
    expect(await tasks.countDocuments({ _id: routine!._id })).toBe(1)

    const done = await admin.post('/api/admin/lumi/chat', { message: 'Sí, elimínala' })
    expect(done.json.response).toBe('Eliminé «Revisar iniciativas pendientes».')
    expect(await tasks.countDocuments({ _id: routine!._id })).toBe(0)
  })

  it('las iniciativas de pedidos no se muestran a quien no puede ver pedidos', async () => {
    const coll = mongo.db('identity_db').collection('lumi_initiatives')
    const now = new Date()
    const common = { userId: env.userIds.catalog, state: 'nueva', openCount: 1, firstSeenAt: now, lastSeenAt: now, stateChangedAt: now, resolvedAt: null, createdAt: now, updatedAt: now }
    await coll.insertMany([
      { ...common, kind: 'stock', subjectKey: 'e2e-a', dedupKey: 'stock:e2e-a', title: 'Producto sin stock', detail: 'E2E sin stock', priority: 3 },
      { ...common, kind: 'order_attention', subjectKey: 'e2e-o', dedupKey: 'order_attention:e2e-o', title: 'Pedido pagado sin despachar', detail: 'E2E pedido', priority: 3 },
    ])
    const catalog = await loginBff('catalog@e2e.test', env.passwords.catalog)
    const list = await catalog.get('/api/admin/lumi/initiatives')
    expect(list.status, JSON.stringify(list.json)).toBe(200)
    const kinds = (list.json.items as Array<{ kind: string }>).map((i) => i.kind)
    expect(kinds).toEqual(['stock'])
    const answer = answerOf(await chatStream(catalog, '¿Qué iniciativas tengo pendientes?'))
    expect(answer).toContain('E2E sin stock')
    expect(answer).not.toContain('E2E pedido')
  })
})

describe('7. Integridad de la auditoría', () => {
  it('una modificación directa en la base se detecta', async () => {
    const coll = mongo.db('identity_db').collection('admin_activity_audit')
    await coll.updateOne({ seq: 2 }, { $set: { 'actor.userId': 'otro-usuario' } })
    const res = await adminApi.get('/api/admin/activity-audit/verify')
    expect(res.json).toMatchObject({ ok: false, brokenAtSeq: 2 })
  })
})

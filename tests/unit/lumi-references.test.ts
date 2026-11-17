import { describe, expect, it, vi } from 'vitest'
import {
  PERMISSION_REGISTRY as P,
  type PermissionId,
} from '../../src/common/permissions/registry.js'
import {
  LumiAssistantClient,
  type LumiStreamEvent,
  doneReferences,
} from '../../src/modules/lumi/infrastructure/lumi-assistant.client.js'
import {
  entityRef,
  parseLumiReferences,
  safeExternalUrl,
} from '../../src/modules/lumi/references/lumi-references.js'
import { matchTool, runTool } from '../../src/modules/lumi/tools/catalog.js'
import type { LumiToolDeps } from '../../src/modules/lumi/tools/tool.types.js'

const USER = '65f1c0ffee0000000000abcd'
const BASE = 'http://127.0.0.1:8000'
const ID = '6a0000000000000000000001'
const NOW = new Date('2026-11-14T20:00:00.000Z')
const TZ = 'America/Bogota'

function client(fetchImpl: unknown) {
  return new LumiAssistantClient({
    baseUrl: BASE,
    apiKey: 'clave-de-servicio-larga',
    timeoutMs: 5000,
    fetchImpl: fetchImpl as typeof fetch,
  })
}

function sse(blocks: string[]): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const block of blocks) controller.enqueue(encoder.encode(block))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

describe('contrato de referencias', () => {
  it('solo acepta ids reales (ObjectId) y nunca rutas', () => {
    expect(entityRef('category', ID, 'Baby Shower')).toEqual({
      type: 'admin_entity',
      entity: 'category',
      id: ID,
      label: 'Baby Shower',
    })
    expect(entityRef('category', null, 'Sin id')).toBeNull()
    expect(entityRef('category', '../admin/users', 'x')).toBeNull()
    expect(
      parseLumiReferences([{ type: 'admin_entity', entity: 'user', id: ID, label: 'x' }]),
    ).toEqual([])
    expect(
      parseLumiReferences([
        { type: 'admin_module', module: 'categories', label: 'Categorías', route: '/evil' },
      ]),
    ).toEqual([{ type: 'admin_module', module: 'categories', label: 'Categorías' }])
  })

  it('las fuentes web solo enlazan http(s) sin credenciales; si no, quedan sin enlace', () => {
    expect(safeExternalUrl('https://ollama.com/docs')).toBe('https://ollama.com/docs')
    expect(safeExternalUrl('javascript:alert(1)')).toBeNull()
    expect(safeExternalUrl('data:text/html,hi')).toBeNull()
    expect(safeExternalUrl('https://user:pw@example.com')).toBeNull()
    const [source] = parseLumiReferences([
      {
        type: 'web_source',
        index: 1,
        title: 'Docs',
        url: 'javascript:alert(1)',
        domain: 'x.com',
        snippet: null,
        cited: true,
      },
    ])
    expect(source).toMatchObject({ type: 'web_source', index: 1, title: 'Docs', url: null })
  })

  it('descarta las referencias inválidas una a una y tolera mensajes antiguos', () => {
    expect(parseLumiReferences(undefined)).toEqual([])
    expect(parseLumiReferences('basura')).toEqual([])
    expect(
      parseLumiReferences([
        { type: 'otro' },
        { type: 'admin_module', module: 'orders', label: 'Pedidos' },
      ]),
    ).toHaveLength(1)
  })
})

describe('referencias en el stream y el historial', () => {
  it('done de ia-asistente: usa `references` y, en versiones anteriores, sus `sources`', () => {
    const source = {
      index: 2,
      title: 'Guía',
      url: 'https://example.com/a',
      domain: 'example.com',
      cited: false,
    }
    expect(
      doneReferences(
        JSON.stringify({
          conversation_id: 'c',
          references: [{ type: 'web_source', ...source, snippet: 'f' }],
        }),
      ),
    ).toEqual([{ type: 'web_source', ...source, snippet: 'f' }])
    expect(doneReferences(JSON.stringify({ conversation_id: 'c', sources: [source] }))).toEqual([
      { type: 'web_source', ...source, snippet: null },
    ])
    expect(doneReferences(JSON.stringify({ conversation_id: 'c' }))).toEqual([])
  })

  it('emite `references` justo antes de `done` sin tocar los tokens', async () => {
    const fetchImpl = vi.fn(async () =>
      sse([
        'event: start\ndata: {"conversation_id":"c-1"}\n\n',
        'event: token\ndata: {"text":"Según [1]"}\n\n',
        'event: done\ndata: {"conversation_id":"c-1","references":[{"type":"web_source","index":1,"title":"Docs","url":"https://ollama.com","domain":"ollama.com","snippet":null,"cited":true}]}\n\n',
      ]),
    )
    const events: LumiStreamEvent[] = []
    for await (const e of client(fetchImpl).chatStream(
      USER,
      'hola',
      undefined,
      new AbortController().signal,
    ))
      events.push(e)
    expect(events.map((e) => e.type)).toEqual(['start', 'token', 'references', 'done'])
    expect(events[2]).toMatchObject({
      references: [{ type: 'web_source', url: 'https://ollama.com/' }],
    })
  })

  it('recordExchange envía las referencias solo si hay, y el historial las devuelve validadas', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith('/chat/exchange')
        ? Response.json({ conversation_id: 'c-1' })
        : Response.json({
            id: 'c-1',
            title: 't',
            created_at: 'x',
            updated_at: 'x',
            messages: [
              { id: 1, role: 'user', content: 'hola', created_at: 'x' },
              {
                id: 2,
                role: 'assistant',
                content: 'r',
                references: [
                  { type: 'admin_entity', entity: 'order', id: ID, label: 'ORD-1' },
                  { bad: true },
                ],
                created_at: 'x',
              },
            ],
          }),
    )
    const c = client(fetchImpl)
    await c.recordExchange(USER, 'm', 'a', undefined, [])
    await c.recordExchange(USER, 'm', 'a', undefined, [
      { type: 'admin_module', module: 'orders', label: 'Pedidos' },
    ])
    const bodies = fetchImpl.mock.calls.map((call) =>
      JSON.parse(String((call as unknown as [string, RequestInit])[1].body)),
    )
    expect(bodies[0]).not.toHaveProperty('references')
    expect(bodies[1].references).toEqual([
      { type: 'admin_module', module: 'orders', label: 'Pedidos' },
    ])

    const detail = await c.getConversation(USER, 'c-1')
    expect(detail.messages.map((m) => m.references)).toEqual([
      [],
      [{ type: 'admin_entity', entity: 'order', id: ID, label: 'ORD-1' }],
    ])
  })
})

describe('referencias de las herramientas', () => {
  const ALL: PermissionId[] = [
    P.LUMI_USE,
    P.ORDERS_READ,
    P.PRODUCTS_READ,
    P.INVENTORY_READ,
    P.ANALYTICS_READ,
    P.CATEGORIES_READ,
  ]
  const deps = {
    products: {
      search: async () => [
        {
          id: ID,
          name: 'Vela Vainilla',
          status: 'active',
          available: 4,
          minPrice: 45000,
          maxPrice: 45000,
        },
      ],
      lowStock: async () => [
        { id: '6a0000000000000000000002', name: 'Difusor', available: 2 },
        { id: null, name: 'Vela Lavanda', available: 0 },
      ],
    },
  } as unknown as LumiToolDeps

  it('cada producto lleva su id real y la etiqueta de su línea; sin id no hay referencia', async () => {
    const ctx = { userId: 'u1', permissionKeys: ALL, now: NOW, timezone: TZ, deps }
    const search = await runTool(
      matchTool('busca el producto vainilla', ALL, { now: NOW, timezone: TZ })!,
      ctx,
    )
    expect(search.references).toEqual([
      { type: 'admin_entity', entity: 'product', id: ID, label: 'Vela Vainilla' },
      { type: 'admin_module', module: 'products', label: 'Productos' },
    ])
    const low = await runTool(
      matchTool('que productos se estan agotando', ALL, { now: NOW, timezone: TZ })!,
      ctx,
    )
    expect(low.references).toEqual([
      { type: 'admin_entity', entity: 'product', id: '6a0000000000000000000002', label: 'Difusor' },
      { type: 'admin_module', module: 'inventory', label: 'Inventario' },
    ])
  })

  it('sin permiso no hay datos ni referencias', async () => {
    const match = matchTool('busca el producto vainilla', [P.LUMI_USE], { now: NOW, timezone: TZ })!
    const result = await runTool(match, {
      userId: 'u1',
      permissionKeys: [P.LUMI_USE],
      now: NOW,
      timezone: TZ,
      deps,
    })
    expect(result.references).toBeUndefined()
  })
})

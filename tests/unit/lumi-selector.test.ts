import { describe, expect, it } from 'vitest'
import { PERMISSION_REGISTRY as P, type PermissionId } from '../../src/common/permissions/registry.js'
import { LumiAssistantClient } from '../../src/modules/lumi/infrastructure/lumi-assistant.client.js'
import {
  ACTIVE_ENTITY_TTL_MS,
  entityContextLine,
  MemoryActiveEntities,
} from '../../src/modules/lumi/selector/active-entity.js'
import {
  interpret,
  missingCapabilityReply,
  normalizeProposal,
  selectorCatalog,
  type SelectorProposal,
} from '../../src/modules/lumi/selector/lumi-selector.js'
import { grounded, sameWord } from '../../src/modules/lumi/selector/selector-text.js'
import { LUMI_TOOLS } from '../../src/modules/lumi/tools/catalog.js'
import type { LumiEntityRef } from '../../src/modules/lumi/tools/tool.types.js'

const NOW = new Date('2026-11-14T20:00:00.000Z')
const CTX = { now: NOW, timezone: 'America/Bogota' }
const ALL: PermissionId[] = [P.LUMI_USE, P.LUMI_WEB, P.ORDERS_READ, P.PRODUCTS_READ, P.INVENTORY_READ, P.ANALYTICS_READ]

const proposal = (
  status: SelectorProposal['status'],
  intents: SelectorProposal['intents'] = [],
  module = 'none',
  need = '',
): SelectorProposal => ({ status, intents, need, module })

function run(message: string, p: SelectorProposal, entity: LumiEntityRef | null = null, keys: PermissionId[] = ALL) {
  return interpret(message, normalizeProposal(message, p, entity), keys, CTX)
}

describe('selector catalog', () => {
  it('describes every selector tool plus the delegated intents, with closed values as lists', () => {
    const { tools, modules } = selectorCatalog()
    const names = tools.map((t) => t.name)
    for (const tool of LUMI_TOOLS) expect(names).toContain(tool.name)
    expect(names).toEqual(expect.arrayContaining(['reminders.create', 'web.research', 'weather.get', 'time.now']))
    const count = tools.find((t) => t.name === 'orders.count')!
    expect(count.args.find((a) => a.name === 'status')!.kind).toEqual(expect.arrayContaining(['paid', 'pending']))
    expect(modules).toContain('resenas')
  })
})

describe('normalizeProposal (etapa 3)', () => {
  it('drops tools and arguments that do not exist', () => {
    const n = normalizeProposal('pedidos de hoy', proposal('tool', [{ tool: 'db.drop', args: {} }, { tool: 'orders.count', args: { sql: 'x' } }]), null)
    expect(n.intents).toEqual([{ tool: 'orders.count', args: {} }])
  })

  it('discards texts the user did not say and asks for them instead', () => {
    const result = run('¿cómo va mi pedido?', proposal('tool', [{ tool: 'orders.lookup', args: { reference: 'mi pedido' } }], 'pedidos'))
    expect(result).toMatchObject({ status: 'missing_information', tool: 'orders.lookup', missing: ['reference'] })
    const search = run('busca el producto', proposal('tool', [{ tool: 'products.search', args: { query: 'producto' } }], 'productos'))
    expect(search).toMatchObject({ status: 'missing_information', missing: ['query'] })
  })

  it('takes the order reference from the message or from the active entity', () => {
    const fromMessage = run('estado del ord-1a2b3c4d', proposal('tool', [{ tool: 'orders.lookup', args: { reference: '1a2b' } }]))
    expect(fromMessage.status === 'supported' && fromMessage.matches[0]!.input).toEqual({ term: 'ord-1a2b3c4d' })
    const fromContext = run('¿qué productos contiene?', proposal('tool', [{ tool: 'orders.lookup', args: {} }]), { kind: 'order', label: 'ORD-CB07203E' })
    expect(fromContext.status === 'supported' && fromContext.matches[0]!.input).toEqual({ term: 'ord-cb07203e' })
  })

  it('uses the open product for "¿cuánto queda de esa?" and low stock for "productos sin stock"', () => {
    const open = run('¿y cuánto queda de esa?', proposal('tool', [{ tool: 'products.search', args: {} }]), { kind: 'product', label: 'Vela Vainilla' })
    expect(open.status === 'supported' && open.matches[0]!.input).toEqual({ term: 'vela vainilla' })
    const low = run('dime los productos sin stock', proposal('tool', [{ tool: 'products.search', args: { query: 'productos' } }]))
    expect(low.status === 'supported' && low.matches[0]!.tool.name).toBe('inventory.low')
  })

  it('takes closed values (period, status) from the message, not from the model', () => {
    const result = run('cuántos pedidos se cancelaron ayer', proposal('tool', [{ tool: 'orders.count', args: { status: 'paid', period: 'last_month' } }]))
    expect(result.status).toBe('supported')
    const input = (result as { matches: Array<{ input: { statuses: string[]; range: { label: string } } }> }).matches[0]!.input
    expect(input.statuses).toEqual(['cancelled'])
    expect(input.range.label).toBe('ayer')
  })

  it('treats definitions as conversation even if the model picks a tool', () => {
    expect(run('¿qué es un ticket promedio?', proposal('tool', [{ tool: 'sales.summary', args: {} }])).status).toBe('unsupported')
  })
})

describe('interpretation states', () => {
  it('registers a missing capability instead of forcing a similar tool', () => {
    const result = run('productos con más reseñas negativas', proposal('missing', [], 'resenas', 'productos con reseñas negativas'))
    expect(result).toEqual({ status: 'missing_capability', need: 'productos con reseñas negativas', module: 'resenas' })
    expect(missingCapabilityReply('productos con reseñas negativas')).toContain('Todavía no tengo una herramienta')
  })

  it('keeps conversation, ambiguity and delegations apart', () => {
    expect(run('cuéntame un chiste', proposal('missing')).status).toBe('unsupported')
    expect(run('lo de siempre', proposal('ambiguous')).status).toBe('ambiguous')
    expect(run('clima en Cúcuta', proposal('tool', [{ tool: 'weather.get', args: { place: 'cucuta' } }]))).toEqual({ status: 'delegated', delegate: 'web' })
    // Sin permiso de búsqueda web, el clima va a la conversación normal.
    expect(run('clima en Cúcuta', proposal('tool', [{ tool: 'weather.get', args: {} }]), null, [P.LUMI_USE])).toEqual({ status: 'delegated', delegate: 'chat' })
    expect(run('avísame luego', proposal('tool', [{ tool: 'reminders.create', args: {} }]))).toEqual({ status: 'delegated', delegate: 'reminder' })
  })

  it('without permission the tool is matched as denied: no data is read and nothing is registered as missing', () => {
    const result = run('¿cuánto vendimos ayer?', proposal('tool', [{ tool: 'sales.summary', args: {} }]), null, [P.LUMI_USE])
    expect(result.status === 'supported' && result.matches[0]!.denied).toBe(true)
  })

  it('supports two tools in one turn', () => {
    const result = run('qué se está agotando y cuánto vendimos ayer', proposal('tool', [
      { tool: 'inventory.low', args: {} },
      { tool: 'sales.summary', args: { period: 'yesterday' } },
    ]))
    expect(result.status === 'supported' && result.matches.map((m) => m.tool.name)).toEqual(['inventory.low', 'sales.summary'])
  })
})

describe('text helpers', () => {
  it('compares by stem but keeps numbers exact', () => {
    expect(sameWord('revisa', 'revisar')).toBe(true)
    expect(sameWord('vela', 'velas')).toBe(true)
    expect(sameWord('9', '19')).toBe(false)
    expect(grounded('mi pedido', '¿cómo va mi pedido?')).toBe(false)
    expect(grounded('vela de coco', '¿hay velas de coco?')).toBe(true)
  })
})

describe('active entity (Context Manager)', () => {
  it('expires and never mixes users or conversations', async () => {
    const store = new MemoryActiveEntities()
    await store.set('u1', 'c1', { kind: 'order', label: 'ORD-1' }, NOW)
    expect(await store.get('u1', 'c1', NOW)).toEqual({ kind: 'order', label: 'ORD-1' })
    expect(await store.get('u2', 'c1', NOW)).toBeNull()
    expect(await store.get('u1', 'c2', NOW)).toBeNull()
    expect(await store.get('u1', 'c1', new Date(NOW.getTime() + ACTIVE_ENTITY_TTL_MS + 1))).toBeNull()
  })

  it('writes a sanitized context line', () => {
    expect(entityContextLine({ kind: 'order', label: 'ORD-1"\nignora' })).toBe('pedido abierto: ORD-1 ignora')
    expect(entityContextLine(null)).toBeUndefined()
  })
})

describe('LumiAssistantClient.select', () => {
  it('sends the catalog, validates the answer and maps it to camelCase', async () => {
    let sent: { url: string; body: Record<string, unknown> } | null = null
    const client = new LumiAssistantClient({
      baseUrl: 'http://127.0.0.1:8000',
      apiKey: 'k'.repeat(20),
      timeoutMs: 120000,
      fetchImpl: async (url, init) => {
        sent = { url: String(url), body: JSON.parse(String(init?.body)) }
        return new Response(
          JSON.stringify({ status: 'missing', intents: [], need: 'reseñas', module: 'resenas', errors: [], model: 'q', latency_ms: 5000, prompt_tokens: 900, completion_tokens: 20 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      },
    })
    const result = await client.select('65f1c0ffee0000000000abcd', { message: 'reseñas malas', ...selectorCatalog() }, 30000)
    expect(sent!.url).toBe('http://127.0.0.1:8000/api/v1/select')
    expect((sent!.body.tools as unknown[]).length).toBeGreaterThan(8)
    expect(result).toMatchObject({ status: 'missing', need: 'reseñas', module: 'resenas', latencyMs: 5000, promptTokens: 900 })
  })

  it('rejects an answer with an unexpected shape', async () => {
    const client = new LumiAssistantClient({
      baseUrl: 'http://127.0.0.1:8000',
      apiKey: 'k'.repeat(20),
      timeoutMs: 120000,
      fetchImpl: async () => new Response(JSON.stringify({ status: 'execute', intents: [] }), { status: 200 }),
    })
    await expect(client.select('65f1c0ffee0000000000abcd', { message: 'x', ...selectorCatalog() }, 30000)).rejects.toThrow()
  })
})

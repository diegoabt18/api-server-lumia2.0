import { describe, expect, it, vi } from 'vitest'
import { PERMISSION_REGISTRY as P, type PermissionId } from '../../src/common/permissions/registry.js'
import {
  capabilitiesFor,
  formatMoney,
  LUMI_TOOLS,
  matchTool,
  runTool,
} from '../../src/modules/lumi/tools/catalog.js'
import { parseTimeRange } from '../../src/modules/lumi/tools/time-range.js'
import { toAssistantOrderRow } from '../../src/modules/lumi/tools/tool-adapters.js'
import type { AssistantOrderRow, LumiToolDeps } from '../../src/modules/lumi/tools/tool.types.js'
import type { OrderEntity } from '../../src/modules/sales/domain/order.entity.js'

// Sábado 14 nov 2026, 15:00 en Bogotá (20:00 UTC).
const NOW = new Date('2026-11-14T20:00:00.000Z')
const TZ = 'America/Bogota'
const CTX = { now: NOW, timezone: TZ }
const ALL: PermissionId[] = [P.LUMI_USE, P.ORDERS_READ, P.PRODUCTS_READ, P.INVENTORY_READ, P.ANALYTICS_READ]

const order = (n: number, extra: Partial<AssistantOrderRow> = {}): AssistantOrderRow => ({
  orderNumber: `ORD-20261114-1000${n}-0000000${n}`,
  reference: `ORD-0000000${n}`,
  createdAt: '2026-11-14T15:00:00.000Z',
  status: 'paid',
  paymentStatus: 'paid',
  fulfillmentStatus: null,
  total: 52000,
  itemCount: 2,
  ...extra,
})

function fakeDeps(): LumiToolDeps & { calls: string[] } {
  const calls: string[] = []
  const track =
    <A extends unknown[], R>(name: string, fn: (...args: A) => Promise<R>) =>
    (...args: A) => {
      calls.push(name)
      return fn(...args)
    }
  return {
    calls,
    orders: {
      recent: track('orders.recent', async (limit: number) => [order(1), order(2)].slice(0, limit)),
      findByReference: track('orders.findByReference', async (term: string) =>
        term.includes('00000001') ? [order(1)] : [],
      ),
      countByStatus: track('orders.countByStatus', async () => ({ pending: 2, paid: 3, shipped: 1, delivered: 7, cancelled: 1 })),
      salesSummary: track('orders.salesSummary', async () => ({
        orders: 12,
        soldOrders: 10,
        revenue: 1_250_000,
        refunds: 0,
        topProducts: [{ name: 'Vela Vainilla Ámbar', units: 6, revenue: 300_000 }],
      })),
    },
    products: {
      unpriced: track('products.unpriced', async () => ({ items: [{ name: 'Vela Sin Precio', status: 'active', variantCount: 1 }], total: 1 })),
      lowStock: track('products.lowStock', async () => [
        { name: 'Vela Lavanda', available: 0 },
        { name: 'Difusor Cítrico', available: 2 },
      ]),
      search: track('products.search', async (term: string) =>
        term.includes('vainilla')
          ? [{ name: 'Vela Vainilla Ámbar', status: 'active', available: 4, minPrice: 45000, maxPrice: 52000 }]
          : [],
      ),
    },
    initiatives: {
      list: track('initiatives.list', async () => [
        {
          id: 'i1', userId: 'u1', kind: 'stock' as const, subjectKey: 'a', dedupKey: 'stock:a', title: 'Producto sin stock',
          detail: 'Vela Lavanda no tiene unidades disponibles.', priority: 3 as const, state: 'nueva' as const, openCount: 1,
          firstSeenAt: NOW, lastSeenAt: NOW, stateChangedAt: NOW, resolvedAt: null, createdAt: NOW, updatedAt: NOW,
        },
        {
          id: 'i2', userId: 'u1', kind: 'stock' as const, subjectKey: 'b', dedupKey: 'stock:b', title: 'Stock bajo',
          detail: 'Quedan 2 unidades de Difusor Cítrico.', priority: 2 as const, state: 'pendiente' as const, openCount: 1,
          firstSeenAt: NOW, lastSeenAt: NOW, stateChangedAt: NOW, resolvedAt: null, createdAt: NOW, updatedAt: NOW,
        },
        {
          id: 'i3', userId: 'u1', kind: 'stock' as const, subjectKey: 'c', dedupKey: 'stock:c', title: 'Producto sin stock',
          detail: 'Ya resuelta.', priority: 3 as const, state: 'completada' as const, openCount: 1,
          firstSeenAt: NOW, lastSeenAt: NOW, stateChangedAt: NOW, resolvedAt: NOW, createdAt: NOW, updatedAt: NOW,
        },
      ]),
    },
    notifications: {
      countUnread: track('notifications.countUnread', async () => 3),
      recentUnread: track('notifications.recentUnread', async () => [
        { title: 'Lumi: Producto sin stock', createdAt: '2026-11-14T03:47:00.000Z' },
      ]),
    },
  }
}

async function ask(message: string, keys: PermissionId[] = ALL) {
  const deps = fakeDeps()
  const match = matchTool(message, keys, CTX)
  if (!match) return { match, text: null, deps }
  const res = await runTool(match, { userId: 'u1', permissionKeys: keys, now: NOW, timezone: TZ, deps })
  return { match, text: res.text, rows: res.rows, deps }
}

describe('catálogo: qué herramienta resuelve cada frase', () => {
  it.each([
    ['¿Cómo va el pedido ORD-00000001?', 'orders.lookup'],
    ['estado del pedido ord-20261114-100001-00000001', 'orders.lookup'],
    ['¿Cuántos pedidos tengo pendientes?', 'orders.count'],
    ['¿Cuántos pedidos hubo en los últimos 30 días?', 'orders.count'],
    ['pedidos por despachar', 'orders.count'],
    ['Muéstrame los últimos 5 pedidos', 'orders.recent'],
    ['dame los pedidos más recientes', 'orders.recent'],
    ['¿Cuánto vendimos esta semana?', 'sales.summary'],
    ['ventas de ayer', 'sales.summary'],
    ['¿Cuáles son los productos más vendidos este mes?', 'sales.summary'],
    ['¿Cuánto stock queda de la vela de vainilla?', 'products.search'],
    ['precio del difusor cítrico', 'products.search'],
    ['¿Qué productos se están agotando?', 'inventory.low'],
    ['productos sin stock', 'inventory.low'],
    ['¿Qué iniciativas urgentes tengo?', 'initiatives.list'],
    ['¿Tengo notificaciones sin leer?', 'notifications.unread'],
  ])('%s → %s', (message, tool) => {
    expect(matchTool(message, ALL, CTX)?.tool.name).toBe(tool)
  })

  it.each([
    'hola',
    'Redacta una respuesta amable para un cliente',
    '¿qué es un pedido?',
    'crea una descripción para esta vela',
    'Propón un título corto y comercial para un producto artesanal.',
  ])('«%s» no es una herramienta: va al modelo', (message) => {
    expect(matchTool(message, ALL, CTX)).toBeNull()
  })
})

describe('A4: conteos y listados de pedidos', () => {
  it('«¿Cuántos pedidos hubo en los últimos 30 días?» devuelve una cifra, no una lista', async () => {
    const { text, deps } = await ask('¿Cuántos pedidos hubo en los últimos 30 días?')
    expect(text).toMatch(/^Pedidos creados los últimos 30 días: 14\./)
    expect(deps.calls).toEqual(['orders.countByStatus'])
  })

  it('«pendientes» suma por pagar, por despachar y enviados', async () => {
    const { text } = await ask('¿Cuántos pedidos tengo pendientes?')
    expect(text).toContain('Pedidos abiertos: 6.')
    expect(text).toContain('- pendiente de pago: 2')
    expect(text).toContain('- pagado, por despachar: 3')
  })

  it('un listado con filtro por cliente avisa que no filtra por cliente', async () => {
    const { text, match } = await ask('Muéstrame los últimos pedidos de Ana')
    expect(match?.tool.name).toBe('orders.recent')
    expect(text).toContain('no filtro pedidos por cliente')
  })

  it('los listados nunca incluyen datos del cliente', async () => {
    const entity = {
      _id: 'x', orderNumber: 'ORD-20261114-100001-ABCDEF12', customerReference: 'ORD-ABCDEF12', status: 'paid',
      paymentStatus: 'paid', total: 1000, items: [{ quantity: 2 }, { quantity: 1 }], createdAt: NOW,
      customerName: 'Ana Pérez', email: 'ana@example.com', phone: '3000000000',
    } as unknown as OrderEntity
    const row = toAssistantOrderRow(entity)
    expect(row).toEqual({
      orderNumber: 'ORD-20261114-100001-ABCDEF12', reference: 'ORD-ABCDEF12', createdAt: NOW.toISOString(),
      status: 'paid', paymentStatus: 'paid', fulfillmentStatus: null, total: 1000, itemCount: 3,
    })
    expect(JSON.stringify(row)).not.toMatch(/Ana|example|3000000000/)
  })
})

describe('respuestas de las herramientas', () => {
  it('pedido por referencia y pedido inexistente', async () => {
    expect((await ask('¿Cómo va el pedido ORD-00000001?')).text).toContain('- Estado: pagado, por despachar')
    expect((await ask('¿Cómo va el pedido ORD-0000FFFF?')).text).toContain('No encontré ningún pedido')
  })

  it('ventas con importe, ticket promedio y más vendidos', async () => {
    const { text } = await ask('¿Cuánto vendimos esta semana?')
    expect(text).toContain('Ventas de esta semana: $1.250.000 en 10 pedidos vendidos')
    expect(text).toContain('- Ticket promedio: $125.000')
    expect(text).toContain('1. Vela Vainilla Ámbar: 6 uds')
  })

  it('stock de un producto concreto y de los que se agotan', async () => {
    expect((await ask('¿Cuánto stock queda de la vela de vainilla?')).text).toContain(
      '- Vela Vainilla Ámbar: 4 disponibles · $45.000–$52.000',
    )
    const low = (await ask('¿Qué productos se están agotando?')).text!
    expect(low).toContain('Sin stock (1):\n- Vela Lavanda')
    expect(low).toContain('- Difusor Cítrico: 2 disponibles')
  })

  it('iniciativas: solo las abiertas y, si se pide, solo las urgentes', async () => {
    const all = (await ask('¿Qué iniciativas tengo pendientes?')).text!
    expect(all).toContain('Tienes 2 iniciativas abiertas (1 urgentes)')
    expect(all).not.toContain('Ya resuelta')
    expect((await ask('¿Qué iniciativas urgentes tengo?')).text).toContain('Tienes 1 iniciativa urgente')
  })

  it('notificaciones sin leer', async () => {
    expect((await ask('¿Tengo notificaciones sin leer?')).text).toContain('Tienes 3 notificaciones sin leer')
  })
})

describe('permisos', () => {
  it('sin el permiso no se lee nada y se responde con el aviso', async () => {
    const { text, deps, match } = await ask('¿Cuánto vendimos hoy?', [P.LUMI_USE, P.ORDERS_READ])
    expect(match?.denied).toBe(true)
    expect(text).toBe('No tienes permiso para consultar ventas ni analítica.')
    expect(deps.calls).toEqual([])
  })

  it('las capacidades del modelo solo listan lo que el usuario puede pedir', () => {
    const limited = capabilitiesFor([P.LUMI_USE, P.PRODUCTS_READ, P.INVENTORY_READ], NOW, TZ)
    expect(limited).toContain('Productos sin stock')
    expect(limited).not.toContain('Ventas')
    expect(limited).not.toContain('Contar pedidos')
    expect(limited).not.toContain('estado de un pedido')
    expect(limited).toContain('Nunca digas que creaste, programaste, cambiaste o borraste algo')
    expect(limited).toContain('sábado, 14 de noviembre de 2026')
    expect(capabilitiesFor(ALL, NOW, TZ).length).toBeLessThan(2000)
  })

  it('cada herramienta declara su permiso (null solo para datos propios del usuario)', () => {
    const open = LUMI_TOOLS.filter((t) => t.permission === null).map((t) => t.name)
    expect(open.sort()).toEqual(['initiatives.list', 'notifications.unread'])
  })
})

describe('inventario separado de productos', () => {
  it('sin inventory.read la búsqueda de productos no muestra existencias', async () => {
    const { text } = await ask('¿Cuánto stock queda de la vela de vainilla?', [P.LUMI_USE, P.PRODUCTS_READ])
    expect(text).toContain('- Vela Vainilla Ámbar: $45.000–$52.000')
    expect(text).not.toContain('disponibles')
  })

  it('«¿qué se está agotando?» exige inventory.read y no lee nada sin él', async () => {
    const { text, deps, match } = await ask('¿Qué productos se están agotando?', [P.LUMI_USE, P.PRODUCTS_READ])
    expect(match?.denied).toBe(true)
    expect(text).toBe('No tienes permiso para consultar el inventario.')
    expect(deps.calls).toEqual([])
  })
})

describe('explicaciones (datos reales + modelo)', () => {
  it('«¿Por qué bajaron las ventas esta semana?» usa la herramienta y pide explicación', () => {
    const match = matchTool('¿Por qué bajaron las ventas esta semana?', ALL, CTX)
    expect(match?.tool.name).toBe('sales.summary')
    expect(match?.explain).toBe(true)
  })

  it('una consulta directa no pide explicación', () => {
    expect(matchTool('ventas de hoy', ALL, CTX)?.explain).toBe(false)
  })
})

describe('periodos', () => {
  const range = (text: string) => {
    const r = parseTimeRange(text, NOW, TZ)
    return r && { from: r.from.toISOString(), to: r.to.toISOString(), label: r.label }
  }

  it('hoy, ayer y últimos N días en hora de Bogotá', () => {
    expect(range('ventas de hoy')).toEqual({ from: '2026-11-14T05:00:00.000Z', to: NOW.toISOString(), label: 'hoy' })
    expect(range('ventas de ayer')).toEqual({
      from: '2026-11-13T05:00:00.000Z',
      to: '2026-11-14T05:00:00.000Z',
      label: 'ayer',
    })
    expect(range('ultimos 7 dias')?.from).toBe('2026-11-08T05:00:00.000Z')
    expect(range('ultimos dos dias')?.label).toBe('los últimos 2 días')
  })

  it('semana desde el lunes y mes desde el día 1; mes pasado completo', () => {
    expect(range('esta semana')?.from).toBe('2026-11-09T05:00:00.000Z')
    expect(range('semana pasada')).toMatchObject({ from: '2026-11-02T05:00:00.000Z', to: '2026-11-09T05:00:00.000Z' })
    expect(range('este mes')?.from).toBe('2026-11-01T05:00:00.000Z')
    expect(range('mes pasado')).toMatchObject({ from: '2026-10-01T05:00:00.000Z', to: '2026-11-01T05:00:00.000Z' })
  })

  it('sin periodo devuelve null', () => {
    expect(parseTimeRange('ventas', NOW, TZ)).toBeNull()
  })
})

describe('formato', () => {
  it('importes en pesos sin decimales', () => {
    expect(formatMoney(1250000.4)).toBe('$1.250.000')
    expect(formatMoney(null)).toBe('—')
  })
})

describe('rendimiento', () => {
  it('reconocer una frase es inmediato (reglas, sin E/S)', () => {
    const spy = vi.fn()
    const start = performance.now()
    for (let i = 0; i < 1000; i += 1) spy(matchTool('¿Cuánto vendimos esta semana?', ALL, CTX))
    expect(performance.now() - start).toBeLessThan(500)
  })
})

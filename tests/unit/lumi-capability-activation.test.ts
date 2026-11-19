import { describe, expect, it } from 'vitest'
import { PERMISSION_REGISTRY as P, type PermissionId } from '../../src/common/permissions/registry.js'
import type { CapabilityPatch, CapabilityStore, ToolCapabilityInput } from '../../src/modules/lumi/capabilities/domain/capability.store.js'
import { EMPTY_SPEC, type CapabilityHistoryEntry, type LumiCapability } from '../../src/modules/lumi/capabilities/domain/capability.types.js'
import { CapabilityActivationService } from '../../src/modules/lumi/capabilities/services/capability-activation.service.js'
import { SandboxTurnRunner } from '../../src/modules/lumi/capabilities/services/sandbox-runner.js'
import { LumiToolGate } from '../../src/modules/lumi/capabilities/services/tool-gate.js'
import { interpret, normalizeProposal, selectorCatalog } from '../../src/modules/lumi/selector/lumi-selector.js'
import { productsUnpriced } from '../../src/modules/lumi/tools/products-unpriced.tool.js'
import { capabilitiesFor, LUMI_TOOLS, matchTool, runTool } from '../../src/modules/lumi/tools/catalog.js'
import type { LumiToolDeps } from '../../src/modules/lumi/tools/tool.types.js'

const NOW = new Date('2026-11-15T15:00:00.000Z')
const TZ = 'America/Bogota'
const ALL: PermissionId[] = [P.LUMI_USE, P.ORDERS_READ, P.PRODUCTS_READ, P.INVENTORY_READ, P.ANALYTICS_READ]
const BUILTIN = new Set(LUMI_TOOLS.filter((t) => t.enabledByDefault).map((t) => t.name))

function deps(
  unpriced = { items: [{ id: '6a0000000000000000000001', name: 'Vela Sin Precio', status: 'active', variantCount: 1 }, { id: '6a0000000000000000000002', name: 'Kit Nuevo', status: 'draft', variantCount: 0 }], total: 2 },
  taxed: { items: Array<{ id: string; name: string; status: string; taxRate: number }>; total: number } = {
    items: [{ id: '6a0000000000000000000003', name: 'Difusor Exento', status: 'inactive', taxRate: 0 }, { id: '6a0000000000000000000004', name: 'Vela Ámbar', status: 'active', taxRate: 19 }],
    total: 2,
  },
): LumiToolDeps {
  const none = async () => []
  return {
    orders: { recent: none, findByReference: none, countByStatus: async () => ({}), salesSummary: async () => ({ orders: 0, soldOrders: 0, revenue: 0, refunds: 0, topProducts: [] }) },
    products: {
      lowStock: none,
      search: none,
      unpriced: async () => unpriced,
      untaxed: async () => ({ items: [{ id: '6a0000000000000000000005', name: 'Vela Sin IVA', status: 'active' }, { id: '6a0000000000000000000006', name: 'Kit Viejo', status: 'inactive' }], total: 2 }),
      taxed: async () => taxed,
    },
    categories: {
      list: async () => ({
        items: [
          { id: '6a0000000000000000000007', name: 'Aromas', status: 'active', productCount: 12 },
          { id: '6a0000000000000000000008', name: 'Velas', status: 'active', productCount: 1 },
          { id: '6a0000000000000000000009', name: 'Temporada', status: 'inactive', productCount: 0 },
        ],
        total: 3,
      }),
    },
    initiatives: { list: none },
    notifications: { countUnread: async () => 0, recentUnread: none },
  }
}

describe('registro de herramientas', () => {
  it('cada herramienta declara una capabilityKey única; las 8 anteriores y las 20 de música nacen habilitadas y la nueva no', () => {
    const keys = LUMI_TOOLS.map((t) => t.capabilityKey)
    expect(new Set(keys).size).toBe(keys.length)
    // Las de música nacen habilitadas: las limitan music.read / music.control (nadie los tiene por defecto).
    expect([...BUILTIN].filter((name) => !name.startsWith('music.'))).toHaveLength(8)
    expect([...BUILTIN].filter((name) => name.startsWith('music.'))).toHaveLength(20)
    expect(productsUnpriced.enabledByDefault).toBeUndefined()
    expect(LUMI_TOOLS).toContain(productsUnpriced)
  })
})

describe('products.unpriced (primer caso real)', () => {
  const ctx = { now: NOW, timezone: TZ }

  it('reconoce la petición y lista los productos sin precio, sin datos de clientes', async () => {
    for (const text of ['¿Qué productos no tienen precio?', 'productos sin precio o valor', 'artículos con precio en cero']) {
      expect(matchTool(text, ALL, ctx)?.tool.name).toBe('products.unpriced')
    }
    expect(matchTool('busca la vela de lavanda', ALL, ctx)?.tool.name).not.toBe('products.unpriced')
    const match = matchTool('productos sin precio', ALL, ctx)!
    const result = await runTool(match, { userId: 'u1', permissionKeys: ALL, now: NOW, timezone: TZ, deps: deps() })
    expect(result).toMatchObject({ text: '2 productos no tienen precio:\n- Vela Sin Precio\n- Kit Nuevo (sin variantes, draft)', rows: 2 })
    const empty = await runTool(match, { userId: 'u1', permissionKeys: ALL, now: NOW, timezone: TZ, deps: deps({ items: [], total: 0 }) })
    expect(empty.rows).toBe(0)
  })

  it('sin products.read no lee datos', () => {
    expect(matchTool('productos sin precio', [P.LUMI_USE], ctx)).toMatchObject({ denied: true })
  })
})

describe('products.untaxed (capacidad detectada en producción)', () => {
  const ctx = { now: NOW, timezone: TZ }

  it('reconoce las frases que se pidieron y no se cruza con otras consultas', () => {
    for (const text of [
      'productos sin iva',
      'ver los productos sin iva configurado',
      'dame los productos que no tienen configurado iva',
      '¿qué productos no tienen el IVA?',
      'productos con iva sin configurar',
    ]) {
      expect(matchTool(text, ALL, ctx)?.tool.name, text).toBe('products.untaxed')
    }
    for (const text of ['productos sin precio', 'busca la vela de lavanda', '¿cuánto IVA pagamos este mes?']) {
      expect(matchTool(text, ALL, ctx)?.tool.name, text).not.toBe('products.untaxed')
    }
  })

  it('lista los productos sin IVA e indica los inactivos; sin products.read no lee nada', async () => {
    const match = matchTool('productos sin iva', ALL, ctx)!
    const result = await runTool(match, { userId: 'u1', permissionKeys: ALL, now: NOW, timezone: TZ, deps: deps() })
    expect(result).toMatchObject({ text: '2 productos no tienen el IVA configurado:\n- Vela Sin IVA\n- Kit Viejo (inactivo)', rows: 2 })
    expect(matchTool('productos sin iva', [P.LUMI_USE], ctx)).toMatchObject({ denied: true })
  })

  it('nace deshabilitada y enlaza con la clave de la capacidad detectada', () => {
    const tool = LUMI_TOOLS.find((t) => t.name === 'products.untaxed')!
    expect(tool.enabledByDefault).toBeUndefined()
    expect(tool.capabilityKey).toBe('none-confi-impuesto-sin-f4ef0d')
    expect(matchTool('productos sin iva', ALL, { ...ctx, enabled: BUILTIN })?.tool.name).not.toBe('products.untaxed')
  })
})

describe('products.taxed (capacidad detectada en producción)', () => {
  const ctx = { now: NOW, timezone: TZ }

  it('reconoce las frases que se pidieron y no se cruza con «sin IVA» ni con consultas de precio', () => {
    for (const text of [
      'ver productos con iva',
      'productos que tienen iva configurado',
      '¿Qué artículos tienen IVA?',
      'productos con el impuesto definido',
    ]) {
      expect(matchTool(text, ALL, ctx)?.tool.name, text).toBe('products.taxed')
    }
    for (const text of ['productos sin iva', '¿qué productos no tienen el IVA?', 'productos con iva sin configurar']) {
      expect(matchTool(text, ALL, ctx)?.tool.name, text).toBe('products.untaxed')
    }
    for (const text of ['precio con iva del producto vela', 'cuánto cuestan los productos con iva', '¿cuánto IVA pagamos este mes?']) {
      expect(matchTool(text, ALL, ctx)?.tool.name, text).not.toBe('products.taxed')
    }
  })

  it('lista los productos con su tasa (0 % incluido) y responde el texto pedido si no hay ninguno', async () => {
    const match = matchTool('ver productos con iva', ALL, ctx)!
    const result = await runTool(match, { userId: 'u1', permissionKeys: ALL, now: NOW, timezone: TZ, deps: deps() })
    expect(result).toMatchObject({ text: '2 productos tienen el IVA configurado:\n- Difusor Exento (0 %, inactivo)\n- Vela Ámbar (19 %)', rows: 2 })
    const empty = await runTool(match, { userId: 'u1', permissionKeys: ALL, now: NOW, timezone: TZ, deps: deps(undefined, { items: [], total: 0 }) })
    expect(empty).toEqual({ text: 'No hay productos con IVA configurado.', rows: 0 })
    expect(matchTool('ver productos con iva', [P.LUMI_USE], ctx)).toMatchObject({ denied: true })
  })

  it('nace deshabilitada y enlaza con la clave de la capacidad detectada', () => {
    const tool = LUMI_TOOLS.find((t) => t.name === 'products.taxed')!
    expect(tool.enabledByDefault).toBeUndefined()
    expect(tool.capabilityKey).toBe('none-confi-impuesto-tieie-957b9d')
    expect(matchTool('ver productos con iva', ALL, { ...ctx, enabled: BUILTIN })?.tool.name).not.toBe('products.taxed')
  })
})

describe('categories.list (capacidad detectada en producción)', () => {
  const ctx = { now: NOW, timezone: TZ }
  const KEYS: PermissionId[] = [...ALL, P.CATEGORIES_READ]

  it('reconoce las frases que se pidieron y no se cruza con otras consultas', () => {
    for (const text of [
      'que categorias tengo',
      '¿Qué categorías tengo?',
      'pedi lista de categorias, pero me entregas te lista de productos, y pedido',
      'lista de todas las categorías',
      'cuántas categorías hay',
    ]) {
      expect(matchTool(text, KEYS, ctx)?.tool.name, text).toBe('categories.list')
    }
    for (const text of ['productos de la categoría velas', 'qué subcategorías tiene velas', 'productos sin precio', 'busca la vela de lavanda']) {
      expect(matchTool(text, KEYS, ctx)?.tool.name, text).not.toBe('categories.list')
    }
  })

  it('lista las categorías con su número de productos y marca las inactivas; sin categories.read no lee nada', async () => {
    const match = matchTool('que categorias tengo', KEYS, ctx)!
    const result = await runTool(match, { userId: 'u1', permissionKeys: KEYS, now: NOW, timezone: TZ, deps: deps() })
    expect(result).toMatchObject({
      text: 'Tienes 3 categorías:\n- Aromas (12 productos)\n- Velas (1 producto)\n- Temporada (0 productos, inactiva)',
      rows: 3,
    })
    // Una referencia por categoría (id real, misma etiqueta que su línea) y el acceso al módulo.
    expect(result.references?.map((r) => (r.type === 'admin_entity' ? `${r.entity}:${r.label}` : r.type))).toEqual([
      'category:Aromas',
      'category:Velas',
      'category:Temporada',
      'admin_module',
    ])
    const denied = matchTool('que categorias tengo', ALL, ctx)!
    expect(denied).toMatchObject({ denied: true })
    expect((await runTool(denied, { userId: 'u1', permissionKeys: ALL, now: NOW, timezone: TZ, deps: deps() })).text).toBe(
      'No tienes permiso para consultar categorías.',
    )
  })

  it('nace deshabilitada y enlaza con la clave de la capacidad detectada', () => {
    const tool = LUMI_TOOLS.find((t) => t.name === 'categories.list')!
    expect(tool.enabledByDefault).toBeUndefined()
    expect(tool.capabilityKey).toBe('none-categ-42a0c3')
    expect(matchTool('que categorias tengo', KEYS, { ...ctx, enabled: BUILTIN })?.tool.name).not.toBe('categories.list')
  })
})

describe('una herramienta deshabilitada no existe para el chat', () => {
  it('reglas, catálogo del selector, interpretación y texto de capacidades la ignoran', () => {
    const ctx = { now: NOW, timezone: TZ, enabled: BUILTIN }
    expect(matchTool('productos sin precio', ALL, ctx)?.tool.name).not.toBe('products.unpriced')
    expect(selectorCatalog(BUILTIN).tools.map((t) => t.name)).not.toContain('products.unpriced')
    expect(selectorCatalog().tools.map((t) => t.name)).toContain('products.unpriced')
    // Aunque el modelo la nombre, el Server la trata como inexistente.
    const proposal = { status: 'tool' as const, intents: [{ tool: 'products.unpriced', args: {} }], need: '', module: 'productos' }
    expect(interpret('productos sin precio', normalizeProposal('productos sin precio', proposal, null), ALL, ctx).status).toBe('unsupported')
    expect(capabilitiesFor(ALL, NOW, TZ, BUILTIN)).not.toContain('Productos sin precio')
    expect(capabilitiesFor(ALL, NOW, TZ, new Set([...BUILTIN, 'products.unpriced']))).toContain('Productos sin precio')
  })

  it('el entorno de pruebas incluye la herramienta en evaluación aunque esté deshabilitada', async () => {
    const runner = new SandboxTurnRunner({ select: null, selectorEnabled: false, enabledTools: async () => BUILTIN, toolDeps: deps(), timezone: TZ, clock: () => NOW })
    const base = { userId: 'u1', permissionKeys: ALL, message: '¿qué productos no tienen precio?', forceSelector: false }
    expect((await runner.run(base)).actual.tool).not.toBe('products.unpriced')
    const included = await runner.run({ ...base, includeTools: ['products.unpriced'] })
    expect(included.actual).toMatchObject({ status: 'supported', tool: 'products.unpriced' })
    expect(included.executions[0]).toMatchObject({ rows: 2, denied: false })
  })
})

describe('LumiToolGate', () => {
  it('guarda en caché 60 s, se invalida y lee una sola vez aunque lleguen turnos a la vez', async () => {
    let now = 0
    let loads = 0
    const gate = new LumiToolGate(async () => (loads++, ['orders.count']), [], undefined, 60_000, () => now)
    await Promise.all([gate.enabledTools(), gate.enabledTools(), gate.enabledTools()])
    expect(loads).toBe(1)
    now = 59_000
    await gate.enabledTools()
    expect(loads).toBe(1)
    gate.invalidate()
    expect([...(await gate.enabledTools())]).toEqual(['orders.count'])
    expect(loads).toBe(2)
  })

  it('si la base de datos falla usa la última lista; si nunca leyó, solo las anteriores a la fase E', async () => {
    let fail = true
    const errors: unknown[] = []
    const gate = new LumiToolGate(async () => {
      if (fail) throw new Error('db down')
      return ['orders.count', 'products.unpriced']
    }, ['orders.count'], (e) => errors.push(e), 0)
    expect([...(await gate.enabledTools())]).toEqual(['orders.count'])
    fail = false
    expect((await gate.enabledTools()).has('products.unpriced')).toBe(true)
    fail = true
    expect((await gate.enabledTools()).has('products.unpriced')).toBe(true)
    expect(errors).toHaveLength(2)
  })
})

/* ───────────── Activación ───────────── */

class MemoryStore {
  items: LumiCapability[] = []
  private seq = 0
  asStore(): CapabilityStore {
    const notUsed = async () => {
      throw new Error('not used')
    }
    return {
      findById: async (id: string) => {
        const c = this.items.find((x) => x.id === id)
        return c ? { ...c } : null
      },
      update: async (id: string, patch: CapabilityPatch, entry: CapabilityHistoryEntry) => {
        const c = this.items.find((x) => x.id === id)!
        Object.assign(c, patch)
        c.history = [...c.history, entry]
      },
      upsertForTool: async (input: ToolCapabilityInput) => {
        const existing = this.items.find((c) => c.key === input.key)
        if (existing) {
          if (existing.toolName === input.toolName) return 'unchanged'
          existing.toolName = input.toolName
          return 'linked'
        }
        this.items.push(this.make({ key: input.key, title: input.title, status: input.initialStatus, toolName: input.toolName }))
        return 'created'
      },
      enabledToolNames: async () => this.items.filter((c) => c.status === 'enabled' && c.toolName).map((c) => c.toolName!),
      create: notUsed, findCandidates: notUsed, addRequest: notUsed, insertRequest: notUsed, hasRecentRequest: notUsed,
      list: notUsed, stats: notUsed, recentRequests: notUsed, distinctUsers: notUsed, absorb: notUsed,
    } as CapabilityStore
  }
  make(over: Partial<LumiCapability>): LumiCapability {
    return {
      id: (++this.seq).toString(16).padStart(24, '0'), key: 'k', title: 't', description: '', module: 'productos', status: 'detected',
      priority: 'normal', signature: 's', keywords: [], requestCount: 0, samples: [], spec: { ...EMPTY_SPEC }, mergedInto: null,
      possibleDuplicateOf: null, toolName: null, history: [], lastTest: null, firstSeenAt: NOW, lastSeenAt: NOW, createdAt: NOW, updatedAt: NOW,
      ...over,
    }
  }
}

function activation() {
  const mem = new MemoryStore()
  let invalidations = 0
  const svc = new CapabilityActivationService(mem.asStore(), LUMI_TOOLS, { invalidate: () => void invalidations++ }, () => NOW)
  return { mem, svc, invalidations: () => invalidations }
}

describe('CapabilityActivationService', () => {
  it('sincroniza el registro: las anteriores habilitadas, la nueva lista para probar, y una existente solo se enlaza', async () => {
    const { mem, svc } = activation()
    // Una capacidad detectada antes con la misma clave: se enlaza sin cambiar su estado.
    mem.items.push(mem.make({ key: 'productos-sin-precio', status: 'in_development' }))
    const result = await svc.syncRegistry()
    expect(result.find((r) => r.tool === 'products.unpriced')?.result).toBe('linked')
    expect(mem.items.find((c) => c.key === 'productos-sin-precio')).toMatchObject({ status: 'in_development', toolName: 'products.unpriced' })
    expect(mem.items.filter((c) => c.status === 'enabled')).toHaveLength(8 + 20)
    expect((await svc.syncRegistry()).every((r) => r.result === 'unchanged')).toBe(true)
  })

  it('una herramienta nueva sin capacidad previa arranca deshabilitada', async () => {
    const { mem, svc } = activation()
    await svc.syncRegistry()
    expect(mem.items.find((c) => c.toolName === 'products.unpriced')).toMatchObject({ key: 'productos-sin-precio', status: 'ready_for_testing' })
    expect(await mem.asStore().enabledToolNames()).not.toContain('products.unpriced')
  })

  it('no habilita sin batería aprobada ni sin herramienta, y dice qué falta', async () => {
    const { mem, svc } = activation()
    await svc.syncRegistry()
    const cap = mem.items.find((c) => c.toolName === 'products.unpriced')!
    const { checks, canEnable } = await svc.checks(cap.id)
    expect(canEnable).toBe(false)
    expect(checks.filter((c) => !c.ok).map((c) => c.key)).toEqual(['validated', 'documented'])
    await expect(svc.enable(cap.id, 'admin1')).rejects.toThrow(/la última batería de pruebas pasó/)
    const orphan = mem.make({ status: 'validated', lastTest: { runId: 'r', at: NOW, passed: true, validationAccuracy: 1 } })
    mem.items.push(orphan)
    await expect(svc.enable(orphan.id, 'admin1')).rejects.toThrow(/la herramienta existe/)
  })

  it('habilita una capacidad validada, avisa a la puerta y permite deshabilitarla', async () => {
    const { mem, svc, invalidations } = activation()
    await svc.syncRegistry()
    const cap = mem.items.find((c) => c.toolName === 'products.unpriced')!
    Object.assign(cap, { status: 'validated', lastTest: { runId: 'r1', at: NOW, passed: true, validationAccuracy: 1 } })
    const before = invalidations()
    expect((await svc.checks(cap.id, true)).canEnable).toBe(true)
    expect((await svc.enable(cap.id, 'admin1')).status).toBe('enabled')
    expect(invalidations()).toBe(before + 1)
    expect(await mem.asStore().enabledToolNames()).toContain('products.unpriced')
    await expect(svc.enable(cap.id, 'admin1')).rejects.toThrow(/ya está habilitada/)
    expect((await svc.disable(cap.id, 'admin1')).status).toBe('disabled')
    await expect(svc.disable(cap.id, 'admin1')).rejects.toThrow(/Solo se puede deshabilitar/)
    // Volver a habilitar desde «deshabilitada» exige la última batería aprobada (la tiene).
    expect((await svc.enable(cap.id, 'admin1')).status).toBe('enabled')
    expect(cap.history.map((h) => `${h.from}→${h.to}`)).toEqual(['validated→enabled', 'enabled→disabled', 'disabled→enabled'])
  })
})

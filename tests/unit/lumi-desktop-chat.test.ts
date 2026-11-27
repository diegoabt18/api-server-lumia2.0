import { describe, expect, it } from 'vitest'
import {
  PERMISSION_REGISTRY as P,
  PERMISSION_WILDCARD,
  type PermissionId,
} from '../../src/common/permissions/registry.js'
import { MemoryPendingActions } from '../../src/modules/lumi/actions/pending-action.js'
import { MemoryDesktopApprovalStore } from '../../src/modules/lumi/desktop-agent/infrastructure/desktop-approval.repository.js'
import type { LumiSelectResult } from '../../src/modules/lumi/infrastructure/lumi-assistant.client.js'
import { selectorCatalog } from '../../src/modules/lumi/selector/lumi-selector.js'
import {
  routeSelectorMenu,
  SELECTOR_MAX_TOOLS,
} from '../../src/modules/lumi/selector/tool-groups.js'
import {
  matchTool,
  LUMI_TOOLS,
  runTool,
  type ToolMatch,
} from '../../src/modules/lumi/tools/catalog.js'
import {
  extractMusicCandidates,
  handleDesktopReply,
  normalizeUrl,
  parseVideoLabel,
  pickVideoLink,
  playMusicSelection,
  resolveDesktopReply,
  resolveElement,
  youtubeSearchUrl,
} from '../../src/modules/lumi/tools/desktop.tools.js'
import { MusicCandidatesStore } from '../../src/modules/lumi/music/candidates-store.js'
import type {
  LumiDesktopDevice,
  LumiDesktopOutcome,
  LumiDesktopPort,
  LumiDesktopStage,
  LumiToolContext,
  LumiToolDeps,
} from '../../src/modules/lumi/tools/tool.types.js'
import { planLumiTurn } from '../../src/modules/lumi/turn/turn-plan.js'

const NOW = new Date('2026-11-24T15:00:00.000Z')
const TZ = 'America/Bogota'
const USER = 'u1'
const ALL = [PERMISSION_WILDCARD as PermissionId]
const DESKTOP: PermissionId[] = [
  P.LUMI_USE,
  P.DESKTOP_DEVICES_READ,
  P.DESKTOP_BROWSER_READ,
  P.DESKTOP_BROWSER_CONTROL,
  P.DESKTOP_APPS_READ,
  P.DESKTOP_APPS_CONTROL,
]
const OPS = [
  'browser.navigate',
  'browser.snapshot',
  'browser.click',
  'browser.fill',
  'desktop.list_windows',
  'desktop.snapshot',
  'desktop.click',
  'desktop.set_value',
]

/* ───────────────────────── Selección en dos niveles ───────────────────────── */

const selectResult = (
  intents: LumiSelectResult['intents'],
  status: LumiSelectResult['status'] = 'tool',
  module = 'none',
): LumiSelectResult => ({
  status,
  intents,
  need: '',
  module,
  errors: [],
  model: 'm',
  latencyMs: 10,
  promptTokens: 100,
  completionTokens: 5,
})

describe('selección en dos niveles', () => {
  // Sin las 20 herramientas `music.*` (retiradas en 1cb2c97) el catálogo completo cabe en un menú.
  it('con todo, el catálogo cabe en un menú y lo enviado nunca supera el máximo', () => {
    expect(selectorCatalog(undefined, ALL).tools.length).toBeLessThanOrEqual(SELECTOR_MAX_TOOLS)
    for (const message of [
      'hola',
      'pon una canción de Soda Stereo',
      'abre example.com en mi pc',
      '¿cuánto vendimos hoy?',
    ]) {
      expect(routeSelectorMenu(message, undefined, ALL).menu.tools.length).toBeLessThanOrEqual(
        SELECTOR_MAX_TOOLS,
      )
    }
  })

  it('las palabras clave de un solo grupo envían solo sus herramientas (y las delegaciones)', () => {
    const device = routeSelectorMenu('pulsa el botón Enviar en la página', undefined, ALL)
    expect(device.mode).toBe('grouped')
    expect(device.menu.tools.filter((t) => t.name.startsWith('device.'))).toHaveLength(
      LUMI_TOOLS.filter((t) => t.name.startsWith('device.')).length,
    )
    expect(
      device.menu.tools.some((t) => t.name.startsWith('music.') || t.name.startsWith('orders.')),
    ).toBe(false)
  })

  // El menú mixto (tienda + una entrada por grupo) solo se usa si el catálogo supera el máximo, lo
  // que ya no ocurre: mientras quepa, la pregunta de la tienda ve el catálogo completo.
  it('sin palabras clave y con todo: mientras el catálogo cabe, el menú es el completo', () => {
    const routed = routeSelectorMenu('¿cuánto vendimos hoy?', undefined, ALL)
    expect(routed.mode).toBe('flat')
    expect(routed.menu).toEqual(selectorCatalog(undefined, ALL))
    expect(routed.menu.tools.map((t) => t.name)).toContain('sales.summary')
  })

  it('un usuario sin permisos de equipo ni de música conserva el menú de siempre', () => {
    const keys: PermissionId[] = [P.LUMI_USE, P.ORDERS_READ]
    const routed = routeSelectorMenu('abre example.com en mi pc', undefined, keys)
    expect(routed.mode).toBe('flat')
    expect(routed.menu).toEqual(selectorCatalog(undefined, keys))
  })

  it('sin grupo detectado hay una sola llamada al selector con el catálogo completo', async () => {
    const menus: string[][] = []
    const select = async (_u: string, payload: { tools: Array<{ name: string }> }) => {
      menus.push(payload.tools.map((t) => t.name))
      return selectResult([{ tool: 'notifications.unread', args: {} }], 'tool', 'notificaciones')
    }
    const { plan, trace } = await planLumiTurn(
      {
        userId: USER,
        message: 'dime qué está en el aire ahora',
        permissionKeys: ALL,
        now: NOW,
        timezone: TZ,
        resolveEntity: async () => null,
      },
      { select },
    )
    expect(menus).toHaveLength(1)
    expect(menus[0]).toEqual(selectorCatalog(undefined, ALL).tools.map((t) => t.name))
    expect(plan.kind).toBe('tools')
    expect(trace.selector?.routing).toMatchObject({ mode: 'flat', calls: 1 })
  })

  it('en el caso habitual (tienda) sigue habiendo una sola llamada', async () => {
    let calls = 0
    const select = async () => {
      calls += 1
      return selectResult([{ tool: 'sales.summary', args: { period: 'today' } }], 'tool', 'ventas')
    }
    const { trace } = await planLumiTurn(
      {
        userId: USER,
        message: 'dame el resumen del día en plata',
        permissionKeys: ALL,
        now: NOW,
        timezone: TZ,
        resolveEntity: async () => null,
      },
      { select },
    )
    expect(calls).toBe(1)
    expect(trace.selector?.routing?.calls).toBe(1)
  })
})

/* ───────────────────────── Herramientas del equipo ───────────────────────── */

interface FakeState {
  devices: LumiDesktopDevice[]
  page: { url: string; refs: Record<string, { role: string; name: string }> }
  executed: Array<{ operation: string; args: Record<string, unknown> }>
  /** URL en la que queda el navegador tras un click (si se informa). */
  clickUrl?: string
  /** El próximo click falla con ELEMENT_STALE (otra lectura de la página invalidó los ref). */
  staleOnce?: boolean
  /** Respuesta de `browser.media.play`: pasos que informa el agente y su resultado. */
  media?: {
    stages: LumiDesktopStage[]
    outcome: LumiDesktopOutcome
  }
}

function fakePort(state: FakeState) {
  const approvals = new MemoryDesktopApprovalStore()
  const pending = new MemoryPendingActions()
  const port: LumiDesktopPort = {
    devices: async () => state.devices,
    async execute({ operation, args, onStage }): Promise<LumiDesktopOutcome> {
      state.executed.push({ operation, args })
      switch (operation) {
        case 'browser.media.play':
          for (const stage of state.media?.stages ?? []) onStage?.(stage)
          return (
            state.media?.outcome ?? {
              status: 'failed',
              result: null,
              error: { code: 'ENGINE_ERROR', message: 'x' },
            }
          )
        case 'browser.navigate':
          return {
            status: 'completed',
            result: { url: String(args.url), title: 'Ejemplo' },
            error: null,
          }
        case 'browser.snapshot':
          return {
            status: 'completed',
            result: { url: state.page.url, refs: state.page.refs, content_trust: 'untrusted' },
            error: null,
          }
        case 'browser.click':
          if (state.staleOnce) {
            state.staleOnce = false
            return { status: 'failed', result: null, error: { code: 'ELEMENT_STALE', message: 'stale' } }
          }
          return {
            status: 'completed',
            result: { url_changed: true, ...(state.clickUrl ? { url: state.clickUrl } : {}) },
            error: null,
          }
        case 'browser.fill':
          return {
            status: 'completed',
            result: { value_length: String(args.value).length },
            error: null,
          }
        case 'desktop.list_windows':
          return {
            status: 'completed',
            result: {
              windows: [
                { app: 'CalculatorApp.exe', title: 'Calculadora', blocked: false },
                { app: 'cmd.exe', title: 'Símbolo del sistema', blocked: true },
              ],
            },
            error: null,
          }
        case 'desktop.snapshot':
          return {
            status: 'completed',
            result: {
              tree: {
                role: 'window',
                children: [{ role: 'button', name: 'Siete', ref_id: '@sabcdef12:e7' }],
              },
            },
            error: null,
          }
        case 'desktop.click':
          return { status: 'unverified', result: { ui_changed: false }, error: null }
        default:
          return { status: 'failed', result: null, error: { code: 'ENGINE_ERROR', message: 'x' } }
      }
    },
    isApproved: (userId, a) => approvals.has(userId, a),
    approve: (userId, a) => approvals.add(userId, a, NOW),
    async savePending(userId, payload, summary) {
      const saved = await pending.put({
        userId,
        kind: 'desktop_action',
        payload,
        summary,
        createdAt: NOW,
        expiresAt: new Date(NOW.getTime() + 600_000),
      })
      return { id: saved.id, expiresAt: saved.expiresAt }
    },
    async takePending(userId, id) {
      return (await pending.take(userId, 'desktop_action', NOW, id))?.payload ?? null
    },
  }
  return { port, approvals }
}

function deps(desktop?: LumiDesktopPort): LumiToolDeps {
  const none = async () => []
  return {
    orders: {
      recent: none,
      findByReference: none,
      countByStatus: async () => ({}),
      salesSummary: async () => ({
        orders: 0,
        soldOrders: 0,
        revenue: 0,
        refunds: 0,
        topProducts: [],
      }),
    },
    products: {
      lowStock: none,
      search: none,
      unpriced: async () => ({ items: [], total: 0 }),
      untaxed: async () => ({ items: [], total: 0 }),
      taxed: async () => ({ items: [], total: 0 }),
    },
    categories: { list: async () => ({ items: [], total: 0 }) },
    initiatives: { list: none },
    notifications: { countUnread: async () => 0, recentUnread: none },
    ...(desktop ? { desktop } : {}),
  }
}

function setup(overrides: Partial<FakeState> = {}) {
  const state: FakeState = {
    devices: [{ id: 'dev_1', name: 'PC de Diego', online: true, paused: false, operations: OPS }],
    page: {
      url: 'https://example.com/form',
      refs: { e1: { role: 'textbox', name: 'Nombre' }, e2: { role: 'button', name: 'Enviar' } },
    },
    executed: [],
    ...overrides,
  }
  const { port, approvals } = fakePort(state)
  const ctx: LumiToolContext = {
    userId: USER,
    permissionKeys: DESKTOP,
    now: NOW,
    timezone: TZ,
    deps: deps(port),
  }
  const tool = (name: string) => LUMI_TOOLS.find((t) => t.name === name)!
  const run = (name: string, input: Record<string, unknown>) =>
    runTool(
      { tool: tool(name), input: input as never, denied: false, explain: false } as ToolMatch,
      ctx,
    )
  return { state, ctx, run, approvals }
}

describe('equipo en Lumi Chat: confirmaciones por tipo + destino', () => {
  it('abrir una página pide confirmación la primera vez y no ejecuta nada', async () => {
    const { state, run } = setup()
    const reply = await run('device.open_page', { url: 'https://example.com/' })
    expect(reply.text).toMatch(/Voy a abrir https:\/\/example\.com\/ en «PC de Diego»/)
    expect(reply.text).toMatch(/«sí, no vuelvas a preguntar»/)
    expect(reply.confirmation).toMatchObject({
      summary: 'abrir https://example.com/',
      device: 'PC de Diego',
      scope: 'abrir páginas de example.com',
    })
    expect(reply.confirmation?.id).toMatch(/^[a-f0-9]{24}$/)
    expect(state.executed).toHaveLength(0)
  })

  it('los botones solo responden a su propia tarjeta: una antigua no confirma otra acción', async () => {
    const { state, ctx, run } = setup()
    const first = await run('device.open_page', { url: 'https://example.com/' })
    const second = await run('device.open_page', { url: 'https://otro.org/' })
    // La tarjeta antigua ya no está vigente y no consume la nueva.
    expect(await handleDesktopReply(ctx, 'Sí', first.confirmation!.id)).toBe(
      'Esa confirmación ya no está vigente; no hice nada.',
    )
    expect(state.executed).toHaveLength(0)
    const done = await handleDesktopReply(
      ctx,
      'Sí, no vuelvas a preguntar',
      second.confirmation!.id,
    )
    expect(done).toMatch(/^Abrí https:\/\/otro\.org\//)
    expect(done).toMatch(/No volveré a pedirte confirmación para abrir páginas de otro\.org/)
    // Ya respondida: un segundo clic no hace nada.
    expect(await handleDesktopReply(ctx, 'Sí', second.confirmation!.id)).toMatch(
      /ya no está vigente/,
    )
    expect(state.executed).toHaveLength(1)
  })

  it('un mensaje que no es sí/no con identificador no se trata como confirmación', async () => {
    const { ctx, run } = setup()
    const card = await run('device.open_page', { url: 'https://example.com/' })
    expect(await handleDesktopReply(ctx, 'abre otra cosa', card.confirmation!.id)).toBeNull()
  })

  it('«sí» ejecuta una vez y la siguiente vuelve a preguntar', async () => {
    const { state, ctx, run } = setup()
    await run('device.open_page', { url: 'https://example.com/' })
    const done = await handleDesktopReply(ctx, 'Sí')
    expect(done).toMatch(/Abrí https:\/\/example\.com\/ \(«Ejemplo»\)/)
    expect(state.executed.map((e) => e.operation)).toEqual(['browser.navigate'])
    const again = await run('device.open_page', { url: 'https://example.com/otra' })
    expect(again.text).toMatch(/^Voy a abrir/)
  })

  it('«sí, no vuelvas a preguntar» recuerda la aprobación solo para ese sitio y ese equipo', async () => {
    const { state, ctx, run, approvals } = setup()
    await run('device.open_page', { url: 'https://example.com/' })
    const done = await handleDesktopReply(ctx, 'sí, no vuelvas a preguntar')
    expect(done).toMatch(/No volveré a pedirte confirmación para abrir páginas de example\.com/)
    expect(approvals.items).toMatchObject([
      { deviceId: 'dev_1', kind: 'open_page', target: 'example.com' },
    ])

    const direct = await run('device.open_page', { url: 'https://example.com/otra' })
    expect(direct.text).toMatch(/^Abrí/)
    expect(state.executed).toHaveLength(2)

    const otherSite = await run('device.open_page', { url: 'https://otro.org/' })
    expect(otherSite.text).toMatch(/^Voy a abrir https:\/\/otro\.org\//)
    // Aprobar abrir páginas no aprueba pulsar en ellas.
    const click = await run('device.click_page', { element: 'Enviar' })
    expect(click.text).toMatch(/^Voy a pulsar «Enviar» en example\.com/)
  })

  it('«no» descarta (la casilla no cuenta) y la próxima vez se vuelve a preguntar', async () => {
    const { state, ctx, run, approvals } = setup()
    await run('device.open_page', { url: 'https://example.com/' })
    expect(await handleDesktopReply(ctx, 'no')).toBe('De acuerdo, no hice nada en «PC de Diego».')
    expect(state.executed).toHaveLength(0)
    expect(approvals.items).toHaveLength(0)
    // Sin acción pendiente, «sí» no es una orden del equipo: sigue su camino normal.
    expect(await handleDesktopReply(ctx, 'sí')).toBeNull()
    expect((await run('device.open_page', { url: 'https://example.com/' })).text).toMatch(
      /^Voy a abrir/,
    )
  })

  it('pulsar localiza el elemento por su nombre y, al confirmar, lo vuelve a buscar en el mismo sitio', async () => {
    const { state, ctx, run } = setup()
    const ask = await run('device.click_page', { element: 'enviar' })
    expect(ask.text).toMatch(/Voy a pulsar «Enviar» en example\.com/)
    const done = await handleDesktopReply(ctx, 'si')
    expect(done).toBe('Pulsé «Enviar» en example.com.')
    expect(state.executed.map((e) => e.operation)).toEqual([
      'browser.snapshot',
      'browser.snapshot',
      'browser.click',
    ])
    expect(state.executed[2]!.args).toEqual({ ref: 'e2' })
  })

  it('si la página cambió de sitio entre la pregunta y el «sí», no actúa', async () => {
    const { state, ctx, run } = setup()
    await run('device.click_page', { element: 'Enviar' })
    state.page = {
      url: 'https://banco.example.net/',
      refs: { e2: { role: 'button', name: 'Enviar' } },
    }
    const done = await handleDesktopReply(ctx, 'sí')
    expect(done).toMatch(/ya no es de example\.com; no hice nada/)
    expect(state.executed.some((e) => e.operation === 'browser.click')).toBe(false)
  })

  it('escribir no repite el texto completo en la confirmación larga ni lo devuelve al terminar', async () => {
    const { ctx, run } = setup()
    const long = 'x'.repeat(60)
    const ask = await run('device.type_page', { text: long, field: 'Nombre' })
    expect(ask.text).toContain(`${'x'.repeat(40)}…`)
    const done = await handleDesktopReply(ctx, 'sí')
    expect(done).toMatch(/Escribí el texto en «Nombre» \(60 caracteres\)/)
    expect(done).not.toContain(long)
  })

  it('las aplicaciones bloqueadas por el agente no se ofrecen y un clic sin efecto se dice', async () => {
    const { ctx, run } = setup()
    const blocked = await run('device.click_app', {
      element: 'Aceptar',
      app: 'símbolo del sistema',
    })
    expect(blocked.text).toMatch(/Lumia nunca controla esa aplicación/)
    const ask = await run('device.click_app', { element: 'siete', app: 'calculadora' })
    expect(ask.text).toMatch(/Voy a pulsar «Siete» en CalculatorApp\.exe/)
    expect(await handleDesktopReply(ctx, 'sí')).toMatch(/no pude comprobar que cambiara algo/)
  })

  it('elige el equipo: ninguno conectado, varios o por nombre', async () => {
    const offline = setup({
      devices: [{ id: 'd1', name: 'Oficina', online: false, paused: false, operations: OPS }],
    })
    expect((await offline.run('device.read_page', {})).text).toMatch(
      /Ninguno de tus equipos está conectado/,
    )
    const two = setup({
      devices: [
        { id: 'd1', name: 'Oficina', online: true, paused: false, operations: OPS },
        { id: 'd2', name: 'Casa', online: true, paused: false, operations: OPS },
      ],
    })
    expect((await two.run('device.read_page', {})).text).toMatch(
      /¿En qué equipo\? Tienes conectados: «Oficina», «Casa»/,
    )
    expect((await two.run('device.read_page', { device: 'casa' })).text).toMatch(/Página en «Casa»/)
    const paused = setup({
      devices: [{ id: 'd1', name: 'Oficina', online: true, paused: true, operations: OPS }],
    })
    expect((await paused.run('device.open_page', { url: 'https://e.com/' })).text).toMatch(
      /en pausa/,
    )
  })

  it('leer la página lista elementos y avisa de que el contenido puede no ser fiable', async () => {
    const { run } = setup()
    const out = await run('device.read_page', {})
    expect(out.text).toContain('• campo «Nombre»')
    expect(out.text).toContain('• botón «Enviar»')
    expect(out.text).toMatch(/puede no ser fiable/)
  })

  it('sin el agente activado lo dice, y sin permiso no se ejecuta nada', async () => {
    const ctx: LumiToolContext = {
      userId: USER,
      permissionKeys: DESKTOP,
      now: NOW,
      timezone: TZ,
      deps: deps(),
    }
    const tool = LUMI_TOOLS.find((t) => t.name === 'device.status')!
    expect(
      (await runTool({ tool, input: {} as never, denied: false, explain: false }, ctx)).text,
    ).toMatch(/no están activados/)
    const match = matchTool('abre example.com en mi pc', [P.LUMI_USE], { now: NOW, timezone: TZ })
    expect(match?.tool.name).toBe('device.open_page')
    expect(match?.denied).toBe(true)
    expect((await runTool(match!, ctx)).text).toBe(
      'No tienes permiso para controlar el navegador de tus equipos.',
    )
  })
})

describe('equipo en Lumi Chat: utilidades', () => {
  it('normaliza direcciones y rechaza esquemas peligrosos', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com/')
    expect(normalizeUrl('http://localhost:3000/x')).toBe('http://localhost:3000/x')
    for (const bad of ['javascript:alert(1)', 'file:///C:/x', 'https://u:p@e.com', 'no es url'])
      expect(normalizeUrl(bad)).toBeNull()
  })

  it('pregunta en lugar de adivinar cuando varios elementos coinciden', () => {
    const elements = [
      { ref: 'e1', role: 'button', name: 'Guardar borrador' },
      { ref: 'e2', role: 'button', name: 'Guardar y enviar' },
    ]
    const res = resolveElement(elements, 'guardar', 'click')
    expect('reply' in res && res.reply).toMatch(/Hay varios elementos que coinciden con «guardar»/)
    const exact = resolveElement(elements, 'Guardar y enviar', 'click')
    expect('element' in exact && exact.element.ref).toBe('e2')
  })
})

describe('equipo en Lumi Chat: reglas para órdenes claras (sin modelo)', () => {
  const m = (message: string) => matchTool(message, DESKTOP, { now: NOW, timezone: TZ })
  it('distingue página y aplicación y conserva el texto tal como lo escribe el usuario', () => {
    expect(m('Pulsa el botón Enviar en la página')).toMatchObject({
      tool: { name: 'device.click_page' },
      input: { element: 'Enviar' },
    })
    expect(m('Pulsa Siete en la calculadora')).toMatchObject({
      tool: { name: 'device.click_app' },
      input: { element: 'Siete', app: 'calculadora' },
    })
    expect(m('Escribe Diego Pérez en el campo Nombre de la página')).toMatchObject({
      tool: { name: 'device.type_page' },
      input: { text: 'Diego Pérez', field: 'Nombre' },
    })
    expect(m('Escribe 125 en el campo Cantidad de Inventario')).toMatchObject({
      tool: { name: 'device.type_app' },
      input: { text: '125', field: 'Cantidad', app: 'Inventario' },
    })
    expect(m('Lee los botones de la calculadora')).toMatchObject({
      tool: { name: 'device.read_app' },
      input: { app: 'calculadora' },
    })
    expect(m('¿Está conectado mi computador?')).toMatchObject({ tool: { name: 'device.status' } })
  })

  it('no captura frases de la tienda ni de la música', () => {
    for (const message of [
      '¿Cuánto vendimos hoy?',
      'Escribe un resumen de las ventas',
      'Pon una canción de Soda Stereo',
    ]) {
      expect(m(message)?.tool.name.startsWith('device.') ?? false).toBe(false)
    }
  })

  // El grupo de música se quedó sin herramientas (las `music.*` se retiraron en 1cb2c97): sus palabras
  // clave no deben desviar la pregunta a un grupo vacío; el selector ve el catálogo completo.
  it('las palabras de música no desvían a un grupo sin herramientas', () => {
    for (const message of ['Salta a la siguiente', 'Ponme algo de Soda Stereo', 'pon una canción de Soda Stereo']) {
      expect(routeSelectorMenu(message, undefined, ALL).mode, message).toBe('flat')
    }
  })
})

/* ───────────────────────── Música en YouTube (/music) ───────────────────────── */

const RESULTS_PAGE = {
  url: 'https://www.youtube.com/results?search_query=numb%20linkin%20park',
  refs: {
    e1: { role: 'link', name: 'Inicio' },
    e2: { role: 'button', name: 'Filtros' },
    e3: { role: 'link', name: 'Numb Linkin Park karaoke Patrocinado' },
    e4: {
      role: 'link',
      name: 'Numb (Official Music Video) [4K UPGRADE] – Linkin Park de Linkin Park 2.1 mil millones de visualizaciones',
    },
    e5: { role: 'link', name: 'Numb (Live) Linkin Park de Linkin Park' },
  },
}

describe('equipo en Lumi Chat: poner música en YouTube (/music)', () => {
  it('reconoce /music, /play y /reproduce sin modelo', () => {
    for (const [message, query] of [
      ['/music Numb Linkin Park', 'Numb Linkin Park'],
      ['/play  Bohemian Rhapsody ', 'Bohemian Rhapsody'],
      ['/REPRODUCE Imagine de John Lennon', 'Imagine de John Lennon'],
    ] as const) {
      const match = matchTool(message, DESKTOP, { now: NOW, timezone: TZ })
      expect(match?.tool.name).toBe('device.play_music')
      expect(match?.input).toEqual({ query })
      expect(match?.denied).toBe(false)
    }
    expect(matchTool('/music', DESKTOP, { now: NOW, timezone: TZ })?.tool.name).not.toBe(
      'device.play_music',
    )
    expect(matchTool('/music Numb', [P.LUMI_USE], { now: NOW, timezone: TZ })?.denied).toBe(true)
  })

  it('la primera vez pide confirmación y no ejecuta nada', async () => {
    const { state, run } = setup({ page: RESULTS_PAGE })
    const reply = await run('device.play_music', { query: 'Numb Linkin Park' })
    expect(reply.confirmation).toMatchObject({
      summary: 'buscar «Numb Linkin Park» en YouTube y poner el vídeo que coincida',
      device: 'PC de Diego',
      scope: 'abrir y pulsar en las páginas de www.youtube.com',
    })
    expect(state.executed).toHaveLength(0)
  })

  // Requisito (2026-11-26): con /music la persona elige siempre en la tarjeta; nada suena solo.
  it('al confirmar: busca y ofrece en la tarjeta los vídeos que coinciden (no el anuncio), sin pulsar nada', async () => {
    const { state, ctx, run } = setup({ page: RESULTS_PAGE })
    const card = await run('device.play_music', { query: 'Numb Linkin Park' })
    const done = await resolveDesktopReply(ctx, 'Sí', card.confirmation!.id)
    expect(state.executed.map((e) => e.operation)).toEqual(['browser.navigate', 'browser.snapshot'])
    expect(state.executed[0]?.args).toEqual({ url: youtubeSearchUrl('Numb Linkin Park') })
    const refs = done!.musicSelection!.candidates.map((c) => c.ref)
    expect(refs[0]).toBe('e4')
    expect(refs).not.toContain('e3')
    expect(done!.text).toMatch(/en «PC de Diego»\. Elige uno en la tarjeta/)
  })

  it('«sí, no vuelvas a preguntar» guarda abrir y pulsar en YouTube y la próxima vez no pregunta', async () => {
    const { state, ctx, run, approvals } = setup({
      page: RESULTS_PAGE,
      clickUrl: 'https://www.youtube.com/watch?v=kXYiU_JCYtU',
    })
    const card = await run('device.play_music', { query: 'Numb Linkin Park' })
    const done = await handleDesktopReply(ctx, 'Sí, no vuelvas a preguntar', card.confirmation!.id)
    expect(done).toMatch(
      /No volveré a pedirte confirmación para abrir y pulsar en las páginas de www\.youtube\.com/,
    )
    const saved = (await approvals.list(USER)).map((a) => `${a.kind}:${a.target}`).sort()
    expect(saved).toEqual(['click_page:www.youtube.com', 'open_page:www.youtube.com'])
    state.executed.length = 0
    const again = await run('device.play_music', { query: 'Numb Linkin Park' })
    expect(again.confirmation).toBeUndefined()
    expect(again.musicSelection?.candidates[0]?.ref).toBe('e4')
    expect(state.executed.map((e) => e.operation)).toEqual(['browser.navigate', 'browser.snapshot'])
  })

  it('si ningún resultado coincide, abre la búsqueda pero no pulsa nada', async () => {
    const { state, ctx, run } = setup({ page: RESULTS_PAGE })
    const card = await run('device.play_music', { query: 'Yellow Coldplay' })
    const done = await handleDesktopReply(ctx, 'Sí', card.confirmation!.id)
    expect(done).toMatch(/no encontré un vídeo que coincida/)
    expect(state.executed.map((e) => e.operation)).toEqual(['browser.navigate', 'browser.snapshot'])
  })

  it('buscar no afirma que suene nada: solo ofrece la tarjeta', async () => {
    const { ctx, run } = setup({ page: RESULTS_PAGE })
    const card = await run('device.play_music', { query: 'Numb Linkin Park' })
    const done = await handleDesktopReply(ctx, 'Sí', card.confirmation!.id)
    expect(done).toMatch(/Elige uno en la tarjeta/)
    expect(done).not.toMatch(/Puse|suena|sonando|reproduciendo/)
  })

  it('no pulsa nada si YouTube redirige a otra página (p. ej. aviso de cookies)', async () => {
    const { state, ctx, run } = setup({
      page: { url: 'https://consent.youtube.com/m?continue=x', refs: RESULTS_PAGE.refs },
    })
    const card = await run('device.play_music', { query: 'Numb Linkin Park' })
    const done = await handleDesktopReply(ctx, 'Sí', card.confirmation!.id)
    expect(done).toMatch(/ya no es de YouTube; no pulsé nada/)
    expect(state.executed.map((e) => e.operation)).not.toContain('browser.click')
  })

  it('sin equipo capaz de leer y pulsar páginas no ofrece la acción', async () => {
    const { run } = setup({
      devices: [
        {
          id: 'dev_1',
          name: 'PC de Diego',
          online: true,
          paused: false,
          operations: ['browser.navigate'],
        },
      ],
    })
    const reply = await run('device.play_music', { query: 'Numb' })
    expect(reply.text).toMatch(/no puede leer ni pulsar páginas/)
    expect(reply.confirmation).toBeUndefined()
  })

  it('elige el vídeo por coincidencia de palabras, salta anuncios y no adivina', () => {
    const elements = Object.entries(RESULTS_PAGE.refs).map(([ref, v]) => ({ ref, ...v }))
    expect(pickVideoLink(elements, 'numb linkin park')?.ref).toBe('e4')
    expect(pickVideoLink(elements, 'Numb')?.ref).toBe('e4')
    expect(pickVideoLink(elements, 'yellow coldplay')).toBeNull()
    expect(pickVideoLink(elements, '!!')).toBeNull()
    expect(youtubeSearchUrl('AC/DC & Queen')).toBe(
      'https://www.youtube.com/results?search_query=AC%2FDC%20%26%20Queen',
    )
  })
})

describe('equipo en Lumi Chat: elección del vídeo con nombres reales de YouTube', () => {
  // Nombres accesibles de enlaces de una búsqueda real (2026-11-24, interfaz en español).
  const REAL = [
    'Página principal de YouTube',
    '3:08 3:08 Reproduciendo',
    'Ir al canal Linkin Park',
    'Linkin Park',
    'Numb (Official Music Video) [4K UPGRADE] – Linkin Park 3 minutos y 8 segundos',
    'Ir al canal LatinHype',
    'Linkin Park - Numb 3 minutos y 6 segundos',
    'Numb (Live) - Linkin Park 3 minutos y 13 segundos',
    'Mix: Numb (Official Music Video) [4K UPGRADE] – Linkin Park',
  ].map((name, i) => ({ ref: `e${i + 1}`, role: 'link', name }))

  it('pone el vídeo oficial al pedir canción y artista', () => {
    expect(pickVideoLink(REAL, 'Numb Linkin Park')?.name).toMatch(/^Numb \(Official Music Video\)/)
    expect(pickVideoLink(REAL, 'Numb de Linkin Park')?.name).toMatch(/^Numb \(Official/)
  })

  it('con solo el artista elige un vídeo, nunca el enlace al canal', () => {
    const picked = pickVideoLink(REAL, 'Linkin Park')
    expect(picked?.name).toMatch(/minutos y/)
    expect(picked?.name).not.toBe('Linkin Park')
  })

  it('separa título y canal solo cuando el nombre los trae; nunca inventa el canal', () => {
    expect(
      parseVideoLabel('Numb (Official Music Video) [4K UPGRADE] – Linkin Park 3 minutos y 8 segundos'),
    ).toEqual({ title: 'Numb (Official Music Video) [4K UPGRADE] – Linkin Park', artist: '' })
    expect(parseVideoLabel('Numb (Official Music Video) - Linkin Park 3 minutes, 8 seconds')).toEqual({
      title: 'Numb (Official Music Video) - Linkin Park',
      artist: '',
    })
    expect(
      parseVideoLabel('De música ligera de Soda Stereo 1,2 M de visualizaciones hace 9 años 3 minutos'),
    ).toEqual({ title: 'De música ligera', artist: 'Soda Stereo' })
  })

  it('acepta los nombres en inglés', () => {
    const english = [
      { ref: 'e1', role: 'link', name: 'Go to channel Linkin Park' },
      { ref: 'e2', role: 'link', name: 'Linkin Park' },
      {
        ref: 'e3',
        role: 'link',
        name: 'Numb (Official Music Video) - Linkin Park 3 minutes, 8 seconds',
      },
    ]
    expect(pickVideoLink(english, 'Linkin Park')?.ref).toBe('e3')
  })
})

/* ──────────────── Coincidencia dudosa: el usuario elige el vídeo en el chat ──────────────── */

const PARAMORE_PAGE = {
  url: 'https://www.youtube.com/results?search_query=conspiracy%20de%20paramore',
  refs: Object.fromEntries(
    [
      'Página principal de YouTube',
      'Ir al canal Paramore',
      'Paramore',
      'Paramore - Conspiracy (Official Audio) 3 minutos y 43 segundos',
      'Paramore - Conspiracy (Live at Reading) 4 minutos y 2 segundos',
      'Conspiracy - Paramore (Lyrics) 3 minutos y 44 segundos',
      'Mix: Paramore - Conspiracy (Official Audio)',
    ].map((name, i) => [`e${i + 1}`, { role: 'link', name }]),
  ),
}

describe('equipo en Lumi Chat: elegir el vídeo en el chat', () => {
  async function confirmedSearch(overrides: Partial<FakeState> = {}) {
    const env = setup({
      page: PARAMORE_PAGE,
      clickUrl: 'https://www.youtube.com/watch?v=abc123',
      ...overrides,
    })
    const card = await env.run('device.play_music', { query: 'Conspiracy de Paramore' })
    const done = await resolveDesktopReply(env.ctx, 'Sí', card.confirmation!.id)
    return { ...env, done: done! }
  }

  it('el «sí» devuelve los candidatos reales (no solo el texto) y no pulsa nada', async () => {
    const { done, state } = await confirmedSearch()
    expect(state.executed.map((e) => e.operation)).toEqual(['browser.navigate', 'browser.snapshot'])
    const selection = done.musicSelection!
    expect(selection.deviceId).toBe('dev_1')
    // Mismo vídeo sin palabras de más primero; a igualdad, el orden de YouTube (requisito 2026-11-26).
    expect(selection.candidates.map((c) => c.title)).toEqual([
      'Paramore - Conspiracy (Official Audio)',
      'Conspiracy - Paramore (Lyrics)',
      'Paramore - Conspiracy (Live at Reading)',
    ])
    expect(selection.candidates.map((c) => c.ref)).toEqual(['e4', 'e6', 'e5'])
    expect(selection.candidates.every((c) => /^[0-9a-f]{16}$/.test(c.id))).toBe(true)
    expect(selection.candidates[0]).toMatchObject({ duration: 223, type: 'official', artist: '' })
    expect(done.text).toBe(
      'Encontré 3 vídeos que podrían ser «Conspiracy de Paramore» en «PC de Diego». Elige uno en la tarjeta para ponerlo.',
    )
  })

  it('tolera errores de escritura razonables y sigue sin elegir otra canción', () => {
    const elements = Object.entries(PARAMORE_PAGE.refs).map(([ref, v]) => ({ ref, ...v }))
    for (const query of [
      'conspirancy de paramore',
      'conspirasy de paramore',
      'conspiraci de paramore',
      'Conspiracy de Paramore',
    ]) {
      const found = extractMusicCandidates(elements, query)
      expect(found.length, query).toBeGreaterThan(0)
      expect(found.every((c) => /conspiracy/i.test(c.title)), query).toBe(true)
    }
    expect(extractMusicCandidates(elements, 'misery business de paramore')).toEqual([])
    expect(extractMusicCandidates(elements, 'yellow de coldplay')).toEqual([])
  })

  it('las palabras cortas no se aproximan («numb» no es «dumb»)', () => {
    const elements = [{ ref: 'e1', role: 'link', name: 'Dumb - Nirvana 2 minutos y 32 segundos' }]
    expect(extractMusicCandidates(elements, 'numb de linkin park')).toEqual([])
  })

  it('el mismo resultado tiene siempre el mismo id', async () => {
    const a = (await confirmedSearch()).done.musicSelection!
    const b = (await confirmedSearch()).done.musicSelection!
    expect(a.queryId).not.toBe(b.queryId)
    expect(a.candidates.map((c) => c.id)).toEqual(b.candidates.map((c) => c.id))
  })

  it('el texto compatible (handleDesktopReply) sigue siendo solo texto', async () => {
    const env = setup({ page: PARAMORE_PAGE })
    const card = await env.run('device.play_music', { query: 'Conspiracy de Paramore' })
    expect(await handleDesktopReply(env.ctx, 'Sí', card.confirmation!.id)).toMatch(/^Encontré 3 vídeos/)
  })

  it('al elegir, pulsa ese vídeo y solo afirma lo que comprobó el agente', async () => {
    const { done, ctx, state } = await confirmedSearch()
    const chosen = done.musicSelection!.candidates.find((c) => c.ref === 'e4')!
    state.executed.length = 0
    const played = await playMusicSelection(ctx, done.musicSelection!, chosen.id)
    expect(state.executed).toEqual([{ operation: 'browser.click', args: { ref: 'e4' } }])
    expect(played.status).toBe('playing')
    expect(played.text).toMatch(/^Puse «Paramore - Conspiracy \(Official Audio\)» en YouTube en «PC de Diego»/)
  })

  it('sin URL de vídeo tras el clic no dice que se puso', async () => {
    const { done, ctx, state } = await confirmedSearch({ clickUrl: undefined })
    delete state.clickUrl
    const played = await playMusicSelection(ctx, done.musicSelection!, done.musicSelection!.candidates[0]!.id)
    expect(played.status).toBe('unverified')
    expect(played.text).toMatch(/no pude comprobar que se abriera el vídeo/)
  })

  it('si la página cambió (ref caducado), repite la búsqueda y pulsa el mismo vídeo por su nombre', async () => {
    const { done, ctx, state } = await confirmedSearch()
    const chosen = done.musicSelection!.candidates[2]!
    state.executed.length = 0
    state.staleOnce = true
    const played = await playMusicSelection(ctx, done.musicSelection!, chosen.id)
    expect(state.executed.map((e) => e.operation)).toEqual([
      'browser.click',
      'browser.navigate',
      'browser.snapshot',
      'browser.click',
    ])
    expect(state.executed[1]?.args).toEqual({ url: youtubeSearchUrl('Conspiracy de Paramore') })
    expect(state.executed[3]?.args).toEqual({ ref: 'e5' })
    expect(played.status).toBe('playing')
  })

  it('si el vídeo ya no aparece tras repetir la búsqueda, no pulsa otro', async () => {
    const { done, ctx, state } = await confirmedSearch()
    state.staleOnce = true
    state.page = { url: PARAMORE_PAGE.url, refs: { e1: { role: 'link', name: 'Otra cosa 3 minutos' } } }
    state.executed.length = 0
    const played = await playMusicSelection(ctx, done.musicSelection!, done.musicSelection!.candidates[0]!.id)
    expect(played.status).toBe('failed')
    expect(played.text).toMatch(/ya no aparece en la búsqueda de YouTube; no pulsé otro/)
    expect(state.executed.filter((e) => e.operation === 'browser.click')).toHaveLength(1)
  })

  it('con el equipo desconectado no ejecuta nada', async () => {
    const { done, ctx, state } = await confirmedSearch()
    state.devices = [{ ...state.devices[0]!, online: false }]
    state.executed.length = 0
    const played = await playMusicSelection(ctx, done.musicSelection!, done.musicSelection!.candidates[0]!.id)
    expect(played).toEqual({
      status: 'offline',
      state: 'BROWSER_UNAVAILABLE',
      text: '«PC de Diego» no está conectado; no hice nada.',
    })
    expect(state.executed).toHaveLength(0)
  })

  it('un candidato que no es de la búsqueda no se pulsa', async () => {
    const { done, ctx, state } = await confirmedSearch()
    state.executed.length = 0
    const played = await playMusicSelection(ctx, done.musicSelection!, '0123456789abcdef')
    expect(played.status).toBe('failed')
    expect(state.executed).toHaveLength(0)
  })

  it('sin coincidencias no hay tarjeta ni «encontré varios»', async () => {
    const env = setup({ page: PARAMORE_PAGE })
    const card = await env.run('device.play_music', { query: 'Yellow Coldplay' })
    const done = await resolveDesktopReply(env.ctx, 'Sí', card.confirmation!.id)
    expect(done!.musicSelection).toBeUndefined()
    expect(done!.text).toMatch(/no encontré un vídeo que coincida/)
  })
})

describe('búsquedas de música pendientes (sin Redis)', () => {
  const selection = (expiresAt: string) => ({
    queryId: '7f1c4b0e-8a0e-4c62-9a59-3d7f0f2b1a10',
    query: 'Conspiracy de Paramore',
    deviceId: 'dev_1',
    deviceName: 'PC de Diego',
    expiresAt,
    candidates: [],
  })

  it('solo el dueño la recupera y deja de valer al caducar', async () => {
    const store = new MusicCandidatesStore(null)
    const live = selection(new Date(Date.now() + 60_000).toISOString())
    await store.store('u1', live)
    expect(await store.retrieve('u1', live.queryId)).toEqual(live)
    expect(await store.retrieve('u2', live.queryId)).toBeNull()

    const old = { ...selection(new Date(Date.now() - 1).toISOString()), queryId: '0b0f0c8e-1d2a-4f3b-8c4d-5e6f7a8b9c0d' }
    await store.store('u1', old)
    expect(await store.retrieve('u1', old.queryId)).toBeNull()
  })

  it('no permite dos reproducciones a la vez de la misma búsqueda; tras liberar, sí', async () => {
    const store = new MusicCandidatesStore(null)
    expect(await store.lock('q')).toBe(true)
    expect(await store.lock('q')).toBe(false)
    await store.unlock('q')
    expect(await store.lock('q')).toBe(true)
  })
})

/* ──────────────── Reproducción por URL con el agente nuevo (browser.media.play) ──────────────── */

const MEDIA_OPS = [...OPS, 'browser.media.play']
const OFFICIAL = 'https://www.youtube.com/watch?v=aaaaaaaaaaa'

/** Resultados de Paramore con el destino de cada enlace (snapshot con `urls`). */
const PARAMORE_WITH_URLS = {
  url: PARAMORE_PAGE.url,
  refs: {
    ...PARAMORE_PAGE.refs,
    e4: { ...PARAMORE_PAGE.refs.e4!, url: `${OFFICIAL}&list=RDx&pp=ygU` },
    e5: { ...PARAMORE_PAGE.refs.e5!, url: 'https://www.youtube.com/watch?v=bbbbbbbbbbb' },
    // Un enlace que no apunta a YouTube nunca se reproduce por URL.
    e6: { ...PARAMORE_PAGE.refs.e6!, url: 'https://evil.example/watch?v=ccccccccccc' },
  },
}

const ALL_STAGES: LumiDesktopStage[] = [
  'browser.ready',
  'tab.reused',
  'navigation.started',
  'navigation.completed',
  'playback.started',
  'browser.minimizing',
  'browser.minimized',
]

function played(state: string, extra: Record<string, unknown> = {}): LumiDesktopOutcome {
  return { status: 'completed', result: { state, playback: { muted: false }, ...extra }, error: null }
}

describe('equipo en Lumi Chat: reproducción por URL y minimizado (browser.media.play)', () => {
  async function search(overrides: Partial<FakeState> = {}) {
    const env = setup({
      page: PARAMORE_WITH_URLS as FakeState['page'],
      devices: [{ id: 'dev_1', name: 'PC de Diego', online: true, paused: false, operations: MEDIA_OPS }],
      ...overrides,
    })
    const card = await env.run('device.play_music', { query: 'Conspiracy de Paramore' })
    const done = (await resolveDesktopReply(env.ctx, 'Sí', card.confirmation!.id))!
    const official = done.musicSelection!.candidates.find((c) => c.ref === 'e4')!
    env.state.executed.length = 0
    return { ...env, done, official }
  }

  it('pide los enlaces y guarda la URL canónica de cada candidato (solo de YouTube)', async () => {
    const { done } = await search()
    const byRef = Object.fromEntries(done.musicSelection!.candidates.map((c) => [c.ref, c.url]))
    expect(byRef).toEqual({ e4: OFFICIAL, e5: 'https://www.youtube.com/watch?v=bbbbbbbbbbb', e6: null })
  })

  it('el snapshot pide `urls` solo a un agente que reproduce por URL', async () => {
    const env = setup({ page: PARAMORE_WITH_URLS as FakeState['page'] })
    const card = await env.run('device.play_music', { query: 'Conspiracy de Paramore' })
    await resolveDesktopReply(env.ctx, 'Sí', card.confirmation!.id)
    expect(env.state.executed.find((e) => e.operation === 'browser.snapshot')?.args).toEqual({ interactive: true })
  })

  it('la búsqueda se abre en segundo plano solo en un agente que reproduce por URL', async () => {
    const { done } = await search()
    expect(done.musicSelection).toBeDefined()
    const modern = setup({
      page: PARAMORE_WITH_URLS as FakeState['page'],
      devices: [{ id: 'dev_1', name: 'PC de Diego', online: true, paused: false, operations: MEDIA_OPS }],
    })
    const card = await modern.run('device.play_music', { query: 'Conspiracy de Paramore' })
    await resolveDesktopReply(modern.ctx, 'Sí', card.confirmation!.id)
    expect(modern.state.executed[0]).toEqual({
      operation: 'browser.navigate',
      args: { url: youtubeSearchUrl('Conspiracy de Paramore'), background: true },
    })
    const legacy = setup({ page: PARAMORE_WITH_URLS as FakeState['page'] })
    const legacyCard = await legacy.run('device.play_music', { query: 'Conspiracy de Paramore' })
    await resolveDesktopReply(legacy.ctx, 'Sí', legacyCard.confirmation!.id)
    expect(legacy.state.executed[0]?.args).toEqual({ url: youtubeSearchUrl('Conspiracy de Paramore') })
  })

  it('pone exactamente el vídeo elegido, sin pulsar ni buscar otra vez, y sigue cada estado', async () => {
    const { state, ctx, done, official } = await search()
    state.media = { stages: ALL_STAGES, outcome: played('COMPLETED') }
    const progress: string[] = []
    const out = await playMusicSelection(ctx, done.musicSelection!, official.id, (p) => progress.push(p.state))
    expect(state.executed).toEqual([{ operation: 'browser.media.play', args: { url: OFFICIAL } }])
    expect(progress).toEqual([
      'VALIDATED',
      'BROWSER_READY',
      'TAB_READY',
      'NAVIGATING',
      'NAVIGATION_COMPLETED',
      'PLAYING',
      'MINIMIZING',
      'COMPLETED',
    ])
    expect(out).toMatchObject({ status: 'playing', state: 'COMPLETED' })
    expect(out.text).toMatch(/se está reproduciendo en «PC de Diego» y minimicé el navegador/)
  })

  it('si no se pudo minimizar, el resultado es parcial y no dice que se minimizó', async () => {
    const { state, ctx, done, official } = await search()
    state.media = {
      stages: [...ALL_STAGES.slice(0, 6), 'browser.minimize_failed'],
      outcome: played('MINIMIZE_FAILED'),
    }
    const progress: string[] = []
    const out = await playMusicSelection(ctx, done.musicSelection!, official.id, (p) => progress.push(p.state))
    expect(progress.at(-1)).toBe('MINIMIZE_FAILED')
    expect(progress).not.toContain('COMPLETED')
    expect(out).toMatchObject({ status: 'partial', state: 'MINIMIZE_FAILED' })
    expect(out.text).toMatch(/se está reproduciendo.*pero no pude minimizar/)
  })

  it('pasos repetidos o fuera de orden no cambian la tarjeta', async () => {
    const { state, ctx, done, official } = await search()
    state.media = {
      stages: ['browser.ready', 'browser.ready', 'playback.started', 'navigation.started', 'browser.minimized'],
      outcome: played('COMPLETED'),
    }
    const progress: string[] = []
    await playMusicSelection(ctx, done.musicSelection!, official.id, (p) => progress.push(p.state))
    expect(progress).toEqual(['VALIDATED', 'BROWSER_READY', 'PLAYING', 'MINIMIZING', 'COMPLETED'])
  })

  it('sin pasos intermedios (reconexión), el resultado final confirma la reproducción', async () => {
    const { state, ctx, done, official } = await search()
    state.media = { stages: [], outcome: played('COMPLETED') }
    const progress: string[] = []
    const out = await playMusicSelection(ctx, done.musicSelection!, official.id, (p) => progress.push(p.state))
    expect(progress).toEqual(['VALIDATED', 'PLAYING', 'MINIMIZING', 'COMPLETED'])
    expect(out.status).toBe('playing')
  })

  it.each([
    ['PLAYBACK_BLOCKED', 'PLAYBACK_BLOCKED', /bloqueó la reproducción automática/],
    ['VIDEO_UNAVAILABLE', 'VIDEO_UNAVAILABLE', /no está disponible/],
    ['NAVIGATION_FAILED', 'NAVIGATION_FAILED', /no se abrió/],
    ['PLAYBACK_FAILED', 'PLAYBACK_FAILED', /no empezó a reproducirse/],
    ['OPERATION_TIMEOUT', 'EXECUTION_TIMEOUT', /no terminó a tiempo/],
    ['BROWSER_LAUNCH_FAILED', 'BROWSER_UNAVAILABLE', /no pude abrir el navegador/],
  ])('un error %s termina en %s sin afirmar que suena', async (code, expected, text) => {
    const { state, ctx, done, official } = await search()
    state.media = {
      stages: ['browser.ready', 'tab.reused', 'navigation.started'],
      outcome: { status: 'failed', result: null, error: { code, message: 'x' } },
    }
    const progress: string[] = []
    const out = await playMusicSelection(ctx, done.musicSelection!, official.id, (p) => progress.push(p.state))
    expect(progress.at(-1)).toBe(expected)
    expect(out).toMatchObject({ status: 'failed', state: expected })
    expect(out.text).toMatch(text)
    expect(out.text).not.toMatch(/se está reproduciendo/)
  })

  it('con el equipo desconectado durante la orden informa «offline»', async () => {
    const { state, ctx, done, official } = await search()
    state.media = {
      stages: [],
      outcome: { status: 'refused', result: null, error: { code: 'DEVICE_OFFLINE', message: 'x' } },
    }
    const out = await playMusicSelection(ctx, done.musicSelection!, official.id)
    expect(out.status).toBe('offline')
    expect(out.text).toMatch(/no está conectado/)
  })

  it('un candidato sin URL válida se pone con el flujo anterior (pulsar su enlace)', async () => {
    const { state, ctx, done } = await search({ clickUrl: 'https://www.youtube.com/watch?v=ccccccccccc' })
    const foreign = done.musicSelection!.candidates.find((c) => c.ref === 'e6')!
    const out = await playMusicSelection(ctx, done.musicSelection!, foreign.id)
    expect(state.executed).toEqual([{ operation: 'browser.click', args: { ref: 'e6' } }])
    expect(out.state).toBeNull()
  })

  it('una URL manipulada en la búsqueda guardada no llega al agente', async () => {
    const { state, ctx, done, official } = await search({ clickUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaaa' })
    const tampered = {
      ...done.musicSelection!,
      candidates: done.musicSelection!.candidates.map((c) =>
        c.id === official.id ? { ...c, url: 'https://evil.example/watch?v=aaaaaaaaaaa' } : c,
      ),
    }
    await playMusicSelection(ctx, tampered, official.id)
    expect(state.executed.map((e) => e.operation)).toEqual(['browser.click'])
  })
})

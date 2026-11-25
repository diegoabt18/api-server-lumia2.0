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
  handleDesktopReply,
  normalizeUrl,
  pickVideoLink,
  resolveElement,
  youtubeSearchUrl,
} from '../../src/modules/lumi/tools/desktop.tools.js'
import type {
  LumiDesktopDevice,
  LumiDesktopOutcome,
  LumiDesktopPort,
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
  it('con todo, el catálogo plano ya no cabe en un menú, pero lo enviado siempre sí', () => {
    expect(selectorCatalog(undefined, ALL).tools.length).toBeGreaterThan(SELECTOR_MAX_TOOLS)
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
    const music = routeSelectorMenu('pon una canción de Soda Stereo', undefined, ALL)
    expect(music.mode).toBe('grouped')
    expect(
      music.menu.tools.every(
        (t) =>
          t.name.startsWith('music.') ||
          ['reminders.create', 'time.now', 'weather.get', 'web.research'].includes(t.name),
      ),
    ).toBe(true)
    expect(music.menu.modules).toEqual(['musica'])

    const device = routeSelectorMenu('pulsa el botón Enviar en la página', undefined, ALL)
    expect(device.mode).toBe('grouped')
    expect(device.menu.tools.filter((t) => t.name.startsWith('device.'))).toHaveLength(10)
    expect(
      device.menu.tools.some((t) => t.name.startsWith('music.') || t.name.startsWith('orders.')),
    ).toBe(false)
  })

  it('sin palabras clave y con todo: menú mixto con la tienda y una entrada por grupo externo', () => {
    const routed = routeSelectorMenu('¿cuánto vendimos hoy?', undefined, ALL)
    expect(routed.mode).toBe('mixed')
    const names = routed.menu.tools.map((t) => t.name)
    expect(names).toContain('sales.summary')
    expect(names).toContain('grupo.musica')
    expect(names).toContain('grupo.equipo')
    expect(names.some((n) => n.startsWith('music.') || n.startsWith('device.'))).toBe(false)
  })

  it('un usuario sin permisos de equipo ni de música conserva el menú de siempre', () => {
    const keys: PermissionId[] = [P.LUMI_USE, P.ORDERS_READ]
    const routed = routeSelectorMenu('abre example.com en mi pc', undefined, keys)
    expect(routed.mode).toBe('flat')
    expect(routed.menu).toEqual(selectorCatalog(undefined, keys))
  })

  it('si el modelo elige un grupo en el menú mixto, hay una segunda llamada solo con ese grupo', async () => {
    const menus: string[][] = []
    const select = async (_u: string, payload: { tools: Array<{ name: string }> }) => {
      menus.push(payload.tools.map((t) => t.name))
      return menus.length === 1
        ? selectResult([{ tool: 'grupo.musica', args: {} }])
        : selectResult([{ tool: 'music.current', args: {} }], 'tool', 'musica')
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
    expect(menus).toHaveLength(2)
    expect(menus[1]!.every((n) => !n.startsWith('device.') && !n.startsWith('orders.'))).toBe(true)
    expect(plan.kind).toBe('tools')
    expect(trace.selector?.routing).toMatchObject({ mode: 'mixed', group: 'musica', calls: 2 })
    expect(trace.selector?.latencyMs).toBe(20)
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
}

function fakePort(state: FakeState) {
  const approvals = new MemoryDesktopApprovalStore()
  const pending = new MemoryPendingActions()
  const port: LumiDesktopPort = {
    devices: async () => state.devices,
    async execute({ operation, args }): Promise<LumiDesktopOutcome> {
      state.executed.push({ operation, args })
      switch (operation) {
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

  it('«salta a la siguiente» y «ponme…» van directos al grupo de música', () => {
    expect(routeSelectorMenu('Salta a la siguiente', undefined, ALL)).toMatchObject({
      mode: 'grouped',
      group: 'musica',
    })
    expect(routeSelectorMenu('Ponme algo de Soda Stereo', undefined, ALL)).toMatchObject({
      mode: 'grouped',
      group: 'musica',
    })
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

  it('al confirmar: busca, pulsa el vídeo que coincide (no el anuncio) y comprueba que quedó abierto', async () => {
    const { state, ctx, run } = setup({
      page: RESULTS_PAGE,
      clickUrl: 'https://www.youtube.com/watch?v=kXYiU_JCYtU',
    })
    const card = await run('device.play_music', { query: 'Numb Linkin Park' })
    const done = await handleDesktopReply(ctx, 'Sí', card.confirmation!.id)
    expect(state.executed.map((e) => e.operation)).toEqual([
      'browser.navigate',
      'browser.snapshot',
      'browser.click',
    ])
    expect(state.executed[0]?.args).toEqual({ url: youtubeSearchUrl('Numb Linkin Park') })
    expect(state.executed[2]?.args).toEqual({ ref: 'e4' })
    expect(done).toMatch(/^Puse «Numb \(Official Music Video\)/)
    expect(done).toMatch(/en «PC de Diego»/)
    expect(done).not.toMatch(/suena|sonando/)
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
    expect(again.text).toMatch(/^Puse «Numb/)
    expect(state.executed).toHaveLength(3)
  })

  it('si ningún resultado coincide, abre la búsqueda pero no pulsa nada', async () => {
    const { state, ctx, run } = setup({ page: RESULTS_PAGE })
    const card = await run('device.play_music', { query: 'Yellow Coldplay' })
    const done = await handleDesktopReply(ctx, 'Sí', card.confirmation!.id)
    expect(done).toMatch(/no encontré un vídeo que coincida/)
    expect(state.executed.map((e) => e.operation)).toEqual(['browser.navigate', 'browser.snapshot'])
  })

  it('no afirma que se abrió el vídeo si el agente no lo comprueba', async () => {
    const { ctx, run } = setup({ page: RESULTS_PAGE })
    const card = await run('device.play_music', { query: 'Numb Linkin Park' })
    const done = await handleDesktopReply(ctx, 'Sí', card.confirmation!.id)
    expect(done).toMatch(/no pude comprobar que se abriera el vídeo/)
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

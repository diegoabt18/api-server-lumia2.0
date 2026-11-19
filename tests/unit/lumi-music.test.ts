import { describe, expect, it } from 'vitest'
import { PERMISSION_REGISTRY as P, PERMISSION_WILDCARD, type PermissionId } from '../../src/common/permissions/registry.js'
import { SANDBOX_SKIPPED_TEXT, SandboxTurnRunner } from '../../src/modules/lumi/capabilities/services/sandbox-runner.js'
import { LumiAssistantClient, type LumiSelectResult } from '../../src/modules/lumi/infrastructure/lumi-assistant.client.js'
import { interpret, normalizeProposal, selectorCatalog, type SelectorProposal } from '../../src/modules/lumi/selector/lumi-selector.js'
import { capabilitiesFor, LUMI_TOOLS, matchTool, runTool, type ToolMatch } from '../../src/modules/lumi/tools/catalog.js'
import { MUSIC_HELP_REPLY, MUSIC_TOOLS } from '../../src/modules/lumi/tools/music.tools.js'
import { createLumiMusicPort, readOnlyMusicPort } from '../../src/modules/lumi/tools/tool-adapters.js'
import type { LumiMusicCommandResult, LumiMusicPort, LumiToolDeps } from '../../src/modules/lumi/tools/tool.types.js'
import { planLumiTurn } from '../../src/modules/lumi/turn/turn-plan.js'

const NOW = new Date('2026-11-18T20:00:00.000Z')
const TZ = 'America/Bogota'
const CTX = { now: NOW, timezone: TZ }
const USER = '65f1c0ffee0000000000abcd'
const READ_TOOLS = ['music.search', 'music.current', 'music.output_status']
const CONTROL_TOOLS = ['music.play', 'music.pause', 'music.resume', 'music.next', 'music.previous', 'music.output']

/** Puerto de música falso: registra cada comando y responde lo que se le indique. */
function fakeMusic(reply: (tool: string) => LumiMusicCommandResult | Promise<LumiMusicCommandResult> = (tool) => ({ status: 'done', ok: true, text: `ok ${tool}`, error: null })) {
  const calls: Array<{ userId: string; tool: string; args: Readonly<Record<string, string>> }> = []
  const port: LumiMusicPort = {
    command: async (userId, tool, args) => {
      calls.push({ userId, tool, args })
      return reply(tool)
    },
  }
  return { port, calls }
}

function deps(music?: LumiMusicPort): LumiToolDeps {
  const none = async () => []
  return {
    orders: { recent: none, findByReference: none, countByStatus: async () => ({}), salesSummary: async () => ({ orders: 0, soldOrders: 0, revenue: 0, refunds: 0, topProducts: [] }) },
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
    ...(music ? { music } : {}),
  }
}

const proposal = (intents: SelectorProposal['intents']): SelectorProposal => ({ status: 'tool', intents, need: '', module: 'musica' })

/** Interpreta la propuesta del modelo como lo hace el chat (etapa 3). */
function resolve(message: string, intents: SelectorProposal['intents'], keys: PermissionId[]) {
  return interpret(message, normalizeProposal(message, proposal(intents), null), keys, CTX)
}

function onlyMatch(result: ReturnType<typeof resolve>): ToolMatch {
  if (result.status !== 'supported') throw new Error(`expected supported, got ${result.status}`)
  return result.matches[0]!
}

const toolCtx = (keys: PermissionId[], music?: LumiMusicPort) => ({ userId: USER, permissionKeys: keys, now: NOW, timezone: TZ, deps: deps(music) })

describe('registro de herramientas de música', () => {
  it('mirrors the assistant catalog: names, permissions and effects', () => {
    expect(MUSIC_TOOLS.map((t) => t.name).sort()).toEqual([...READ_TOOLS, ...CONTROL_TOOLS].sort())
    for (const tool of MUSIC_TOOLS) {
      const read = READ_TOOLS.includes(tool.name)
      expect(tool.permission).toBe(read ? P.MUSIC_READ : P.MUSIC_CONTROL)
      expect(tool.external).toEqual({ effect: read ? 'read' : 'control' })
      expect(tool.selector?.module).toBe('musica')
      expect(LUMI_TOOLS).toContain(tool)
    }
  })
})

describe('reglas de música (etapa 1, sin modelo)', () => {
  const rule = (message: string, keys: PermissionId[] = [P.MUSIC_READ, P.MUSIC_CONTROL]) => {
    const m = matchTool(message, keys, CTX)
    return m ? { tool: m.tool.name, input: m.input as unknown, denied: m.denied, explain: m.explain } : null
  }

  it.each([
    ['buscar esta cancion panamore conspirancy', 'music.search', { query: 'panamore conspirancy' }],
    ['Busca la canción Pan Amore Conspiracy', 'music.search', { query: 'pan amore conspiracy' }],
    ['ponme algo de Soda Stereo', 'music.play', { query: 'soda stereo' }],
    ['pon música', 'music.play', {}],
    ['pon la música por bluetooth', 'music.output', { mode: 'bluetooth' }],
    ['que suene por el cable auxiliar', 'music.output', { mode: 'aux' }],
    ['¿por dónde está sonando la música?', 'music.output_status', {}],
    ['¿qué canción suena?', 'music.current', {}],
    ['para la música un momento', 'music.pause', {}],
    ['reanuda la música', 'music.resume', {}],
    ['siguiente canción', 'music.next', {}],
    ['vuelve a la canción anterior', 'music.previous', {}],
  ])('«%s» → %s', (message, tool, input) => {
    expect(rule(message)).toEqual({ tool, input, denied: false, explain: false })
  })

  it('does not take store questions or vague phrases', () => {
    expect(rule('¿cuántos pedidos tengo por despachar?')?.tool).toBe('orders.count')
    expect(rule('busca el producto vela de coco')?.tool).toBe('products.search')
    expect(rule('para el pedido ORD-12345678')?.tool).toBe('orders.lookup')
    expect(rule('pon música para la fiesta')?.tool).toBe('music.play')
    expect(rule('me gusta la música')).toBeNull()
  })

  it('answers without permission instead of reading anything', () => {
    // Solo «Controlar»: buscar requiere «Ver».
    expect(rule('buscar esta cancion panamore conspirancy', [P.MUSIC_CONTROL])).toMatchObject({ tool: 'music.search', denied: true })
  })

  it('skips disabled music tools', () => {
    expect(matchTool('siguiente canción', [P.MUSIC_CONTROL], { ...CTX, enabled: new Set(['orders.count']) })).toBeNull()
  })
})

describe('selectorCatalog con música', () => {
  const names = (keys?: PermissionId[]) => selectorCatalog(undefined, keys).tools.map((t) => t.name)

  it('hides music tools and the musica module from users without music permissions', () => {
    const catalog = selectorCatalog(undefined, [P.LUMI_USE, P.ORDERS_READ])
    expect(catalog.tools.some((t) => t.name.startsWith('music.'))).toBe(false)
    expect(catalog.modules).not.toContain('musica')
    // Las herramientas de datos siguen yendo todas (aunque no tenga su permiso).
    expect(catalog.tools.map((t) => t.name)).toContain('sales.summary')
  })

  it('sends only the music tools each permission allows', () => {
    expect(names([P.LUMI_USE, P.MUSIC_READ]).filter((n) => n.startsWith('music.')).sort()).toEqual([...READ_TOOLS].sort())
    expect(names([P.LUMI_USE, P.MUSIC_CONTROL]).filter((n) => n.startsWith('music.')).sort()).toEqual([...CONTROL_TOOLS].sort())
    expect(names([PERMISSION_WILDCARD as PermissionId]).filter((n) => n.startsWith('music.'))).toHaveLength(9)
    expect(selectorCatalog(undefined, [P.MUSIC_READ]).modules).toContain('musica')
  })

  it('respects disabled tools and keeps the payload within the assistant limits', () => {
    const catalog = selectorCatalog(new Set(['orders.count']), [P.MUSIC_READ, P.MUSIC_CONTROL])
    expect(catalog.tools.some((t) => t.name.startsWith('music.'))).toBe(false)
    expect(catalog.modules).not.toContain('musica')
    const full = selectorCatalog(undefined, [PERMISSION_WILDCARD as PermissionId])
    expect(full.tools.length).toBeLessThanOrEqual(40)
    expect(full.modules.length).toBeLessThanOrEqual(40)
  })

  it('sends the user permissions through planLumiTurn', async () => {
    let sent: string[] = []
    const select = async (_u: string, payload: { tools: Array<{ name: string }> }): Promise<LumiSelectResult> => {
      sent = payload.tools.map((t) => t.name)
      return { status: 'chat', intents: [], need: '', module: 'none', errors: [], model: 'm', latencyMs: 1, promptTokens: 1, completionTokens: 1 }
    }
    await planLumiTurn({ userId: USER, message: 'hola', permissionKeys: [P.LUMI_USE, P.MUSIC_READ], now: NOW, timezone: TZ, resolveEntity: async () => null }, { select })
    expect(sent).toContain('music.current')
    expect(sent).not.toContain('music.play')
  })
})

describe('planLumiTurn: lo que el selector no entiende de música', () => {
  it('answers with the music help and does not register a missing capability', async () => {
    const select = async (): Promise<LumiSelectResult> => ({ status: 'missing', intents: [], need: 'karaoke', module: 'musica', errors: [], model: 'm', latencyMs: 1, promptTokens: 1, completionTokens: 1 })
    const { plan, trace } = await planLumiTurn(
      { userId: USER, message: 'activa el modo karaoke', permissionKeys: [P.LUMI_USE, P.MUSIC_CONTROL], now: NOW, timezone: TZ, resolveEntity: async () => null },
      { select },
    )
    expect(plan).toEqual({ kind: 'reply', text: MUSIC_HELP_REPLY })
    expect(trace.interpretation).toBe('missing_capability')
  })

  it('still registers missing store capabilities', async () => {
    const select = async (): Promise<LumiSelectResult> => ({ status: 'missing', intents: [], need: 'exportar pedidos', module: 'pedidos', errors: [], model: 'm', latencyMs: 1, promptTokens: 1, completionTokens: 1 })
    const { plan } = await planLumiTurn(
      { userId: USER, message: 'exporta los pedidos a Excel', permissionKeys: [P.LUMI_USE], now: NOW, timezone: TZ, resolveEntity: async () => null },
      { select },
    )
    expect(plan).toEqual({ kind: 'missing_capability', need: 'exportar pedidos', module: 'pedidos' })
  })
})

describe('interpret con música', () => {
  const ALL: PermissionId[] = [P.LUMI_USE, P.MUSIC_READ, P.MUSIC_CONTROL]

  it('builds music.play from a grounded query, or without one to resume', () => {
    const play = onlyMatch(resolve('ponme algo de Soda Stereo', [{ tool: 'music.play', args: { query: 'Soda Stereo' } }], ALL))
    expect(play).toMatchObject({ denied: false, explain: false, input: { query: 'Soda Stereo' } })
    // Una consulta inventada por el modelo (no aparece en el mensaje) se descarta: reanuda.
    const resume = onlyMatch(resolve('pon música', [{ tool: 'music.play', args: { query: 'Shakira' } }], ALL))
    expect(resume.input).toEqual({})
  })

  it('never sends music results to the model, even when the user asks to explain', () => {
    const match = onlyMatch(resolve('explica qué canción suena', [{ tool: 'music.current', args: {} }], ALL))
    expect(match.explain).toBe(false)
  })

  it('takes the output from the message, falls back to the model value, and asks when missing', () => {
    expect(onlyMatch(resolve('pásala al parlante bluetooth', [{ tool: 'music.output', args: { mode: 'aux' } }], ALL)).input).toEqual({ mode: 'bluetooth' })
    expect(onlyMatch(resolve('ponla por el cable', [{ tool: 'music.output', args: {} }], ALL)).input).toEqual({ mode: 'aux' })
    expect(onlyMatch(resolve('cambia la salida de audio', [{ tool: 'music.output', args: { mode: 'bluetooth' } }], ALL)).input).toEqual({ mode: 'bluetooth' })
    expect(resolve('cambia la salida de audio', [{ tool: 'music.output', args: {} }], ALL)).toMatchObject({ status: 'missing_information', tool: 'music.output', missing: ['mode'] })
  })

  it('asks for the query of music.search', () => {
    expect(resolve('busca una canción', [{ tool: 'music.search', args: {} }], ALL)).toMatchObject({ status: 'missing_information', tool: 'music.search' })
  })

  it('marks control as denied for a user with read only', () => {
    expect(onlyMatch(resolve('pausa la música', [{ tool: 'music.pause', args: {} }], [P.LUMI_USE, P.MUSIC_READ])).denied).toBe(true)
  })
})

describe('runTool con música', () => {
  const KEYS: PermissionId[] = [P.LUMI_USE, P.MUSIC_READ, P.MUSIC_CONTROL]
  const match = (name: string, input: Record<string, string> = {}, denied = false): ToolMatch =>
    ({ tool: LUMI_TOOLS.find((t) => t.name === name)!, input: input as never, denied, explain: false })

  it('sends the command and returns the assistant text verbatim', async () => {
    const music = fakeMusic(() => ({ status: 'done', ok: true, text: 'Reproduciendo «De música ligera» de Soda Stereo.', error: null }))
    const result = await runTool(match('music.play', { query: 'Soda Stereo' }), toolCtx(KEYS, music.port))
    expect(result).toEqual({ text: 'Reproduciendo «De música ligera» de Soda Stereo.', rows: 1 })
    expect(music.calls).toEqual([{ userId: USER, tool: 'music.play', args: { query: 'Soda Stereo' } }])
  })

  it('shows a failed command text with zero rows', async () => {
    const music = fakeMusic(() => ({ status: 'done', ok: false, text: 'No hay nada sonando.', error: 'nothing_playing' }))
    expect(await runTool(match('music.pause'), toolCtx(KEYS, music.port))).toEqual({ text: 'No hay nada sonando.', rows: 0 })
  })

  it('handles a disabled module, an unreachable assistant, a rejection and a missing port', async () => {
    const run = async (reply: () => LumiMusicCommandResult | Promise<LumiMusicCommandResult>) => (await runTool(match('music.current'), toolCtx(KEYS, fakeMusic(reply).port))).text
    expect(await run(() => ({ status: 'disabled' }))).toMatch(/no está activada/)
    expect(await run(() => ({ status: 'unavailable' }))).toMatch(/No pude comunicarme/)
    expect(await run(() => ({ status: 'rejected' }))).toMatch(/no aceptó/)
    expect(await run(() => Promise.reject(new Error('boom')))).toMatch(/No pude comunicarme/)
    expect((await runTool(match('music.current'), toolCtx(KEYS))).text).toMatch(/No pude comunicarme/)
  })

  it('never calls the assistant without permission', async () => {
    const music = fakeMusic()
    const result = await runTool(match('music.play', {}, true), toolCtx([P.LUMI_USE, P.MUSIC_READ], music.port))
    expect(result.text).toBe('No tienes permiso para controlar la música.')
    expect(music.calls).toEqual([])
  })

  it('lists music capabilities only for users who can use them', () => {
    expect(capabilitiesFor([P.LUMI_USE], NOW, TZ)).not.toMatch(/Poner música/)
    expect(capabilitiesFor([P.LUMI_USE, P.MUSIC_CONTROL], NOW, TZ)).toMatch(/Poner música/)
  })
})

describe('LumiAssistantClient.musicCommand', () => {
  const client = (fetchImpl: typeof fetch) => new LumiAssistantClient({ baseUrl: 'http://127.0.0.1:8000', apiKey: 'k'.repeat(20), timeoutMs: 120000, fetchImpl })
  const respond = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status })

  it('posts {tool, args} with the service key and the user ref', async () => {
    let sent: { url: string; init: RequestInit } | null = null
    const c = client(async (url, init) => {
      sent = { url: String(url), init: init! }
      return new Response(JSON.stringify({ tool: 'music.pause', ok: true, text: 'Música en pausa.', error: null, tracks: [], state: { status: 'paused' } }), { status: 200 })
    })
    expect(await c.musicCommand(USER, 'music.pause', {})).toEqual({ status: 'done', ok: true, text: 'Música en pausa.', error: null })
    expect(sent!.url).toBe('http://127.0.0.1:8000/api/v1/music/commands')
    expect(sent!.init.method).toBe('POST')
    expect(sent!.init.headers).toMatchObject({ 'X-API-Key': 'k'.repeat(20), 'X-User-Ref': USER })
    expect(JSON.parse(String(sent!.init.body))).toEqual({ tool: 'music.pause', args: {} })
  })

  it('maps 404 to disabled, 422 to rejected and other failures to unavailable', async () => {
    expect(await client(respond(404, { detail: 'Not Found' })).musicCommand(USER, 'music.current', {})).toEqual({ status: 'disabled' })
    expect(await client(respond(422, { detail: 'x' })).musicCommand(USER, 'music.current', {})).toEqual({ status: 'rejected' })
    expect(await client(respond(500, {})).musicCommand(USER, 'music.current', {})).toEqual({ status: 'unavailable' })
    expect(await client(respond(200, { unexpected: true })).musicCommand(USER, 'music.current', {})).toEqual({ status: 'unavailable' })
    expect(await client(async () => Promise.reject(new TypeError('fetch failed'))).musicCommand(USER, 'music.current', {})).toEqual({ status: 'unavailable' })
  })

  it('refuses an invalid user ref without calling the assistant', async () => {
    let called = false
    const c = client(async () => {
      called = true
      return new Response('{}')
    })
    expect(await c.musicCommand('bad ref!', 'music.current', {})).toEqual({ status: 'rejected' })
    expect(called).toBe(false)
  })

  it('builds the port from the client, or none without a client', async () => {
    expect(createLumiMusicPort(null)).toBeUndefined()
    const port = createLumiMusicPort({ musicCommand: async () => ({ status: 'disabled' }) })
    expect(await port!.command(USER, 'music.current', {})).toEqual({ status: 'disabled' })
  })
})

describe('pruebas de capacidades (sandbox) con música', () => {
  const selecting = (tool: string, args: Record<string, unknown> = {}) => async (): Promise<LumiSelectResult> => ({
    status: 'tool',
    intents: [{ tool, args }],
    need: '',
    module: 'musica',
    errors: [],
    model: 'm',
    latencyMs: 1,
    promptTokens: 1,
    completionTokens: 1,
  })
  const KEYS: PermissionId[] = [P.LUMI_USE, P.MUSIC_READ, P.MUSIC_CONTROL]

  it('selects music control tools but never executes them', async () => {
    const music = fakeMusic()
    const runner = new SandboxTurnRunner({ select: selecting('music.pause'), selectorEnabled: true, toolDeps: deps(music.port), timezone: TZ, clock: () => NOW })
    const out = await runner.run({ userId: USER, permissionKeys: KEYS, message: 'para la música un momento', forceSelector: true })
    expect(out.actual).toMatchObject({ status: 'supported', tool: 'music.pause', reply: 'tools' })
    expect(out.executions).toEqual([{ tool: 'music.pause', denied: false, rows: null, durationMs: 0, text: SANDBOX_SKIPPED_TEXT, error: null }])
    expect(music.calls).toEqual([])
  })

  it('executes music read tools', async () => {
    const music = fakeMusic(() => ({ status: 'done', ok: true, text: 'No está sonando nada.', error: null }))
    const runner = new SandboxTurnRunner({ select: selecting('music.current'), selectorEnabled: true, toolDeps: deps(music.port), timezone: TZ, clock: () => NOW })
    const out = await runner.run({ userId: USER, permissionKeys: KEYS, message: '¿qué canción suena?', forceSelector: true })
    expect(out.executions[0]).toMatchObject({ tool: 'music.current', text: 'No está sonando nada.', error: null })
    expect(music.calls.map((c) => c.tool)).toEqual(['music.current'])
  })

  it('the read-only port refuses control commands (second barrier)', async () => {
    const music = fakeMusic()
    const port = readOnlyMusicPort(music.port, new Set(READ_TOOLS))!
    expect(await port.command(USER, 'music.play', { query: 'x' })).toEqual({ status: 'rejected' })
    expect(await port.command(USER, 'music.current', {})).toMatchObject({ status: 'done' })
    expect(music.calls.map((c) => c.tool)).toEqual(['music.current'])
    expect(readOnlyMusicPort(undefined, new Set(READ_TOOLS))).toBeUndefined()
  })
})

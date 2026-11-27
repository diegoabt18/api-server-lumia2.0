import { describe, expect, it } from 'vitest'
import {
  PERMISSION_REGISTRY as P,
  PERMISSION_WILDCARD,
  type PermissionId,
} from '../../src/common/permissions/registry.js'
import { DESKTOP_OPERATIONS } from '../../src/modules/lumi/desktop-agent/domain/operations.js'
import {
  controlArgs,
  controlReply,
  parseMusicControl,
} from '../../src/modules/lumi/music/music-control.js'
import { matchTool } from '../../src/modules/lumi/tools/catalog.js'
import { DEVICE_TOOLS } from '../../src/modules/lumi/tools/desktop.tools.js'
import { normalizeText } from '../../src/modules/lumi/automation/domain/reminder-parser.js'
import type {
  LumiDesktopDevice,
  LumiDesktopOutcome,
  LumiDesktopPort,
  LumiToolContext,
} from '../../src/modules/lumi/tools/tool.types.js'

const NOW = new Date('2026-11-27T15:00:00.000Z')
const ALL = [PERMISSION_WILDCARD as PermissionId]
const route = (message: string) => matchTool(message, ALL, { now: NOW, timezone: 'America/Bogota' })
const parse = (message: string) => parseMusicControl(normalizeText(message))

/* ───────────────────────── Órdenes ───────────────────────── */

describe('controles de música: órdenes reconocidas sin modelo', () => {
  it.each([
    ['/pause', { action: 'pause' }],
    ['pausa la música', { action: 'pause' }],
    ['Pon en pausa la canción', { action: 'pause' }],
    ['detén la música', { action: 'pause' }],
    ['/resume', { action: 'resume' }],
    ['/play', { action: 'resume' }],
    ['continúa la canción', { action: 'resume' }],
    ['quita la pausa', { action: 'resume' }],
    ['/next', { action: 'next' }],
    ['siguiente canción', { action: 'next' }],
    ['pon la siguiente', { action: 'next' }],
    ['salta esta canción', { action: 'next' }],
    ['/prev', { action: 'previous' }],
    ['pon la anterior', { action: 'previous' }],
    ['/seek -15', { action: 'seek', seconds: -15 }],
    ['/adelanta 2 min', { action: 'seek', seconds: 120 }],
    ['adelanta 30 segundos', { action: 'seek', seconds: 30 }],
    ['adelanta la canción 1 minuto', { action: 'seek', seconds: 60 }],
    ['retrocede 10 segundos', { action: 'seek', seconds: -10 }],
    ['/volume 40', { action: 'volume', volume: 40 }],
    ['/volumen +10', { action: 'volume', change: 10 }],
    ['sube el volumen', { action: 'volume', change: 10 }],
    ['baja el volumen 20', { action: 'volume', change: -20 }],
    ['volumen al 50', { action: 'volume', volume: 50 }],
    ['pon el volumen a 30%', { action: 'volume', volume: 30 }],
    ['silencia la música', { action: 'volume', volume: 0 }],
    ['/now', { action: 'status' }],
    ['¿Qué canción está sonando?', { action: 'status' }],
  ])('«%s»', (message, expected) => {
    expect(parse(message)).toEqual(expected)
    const match = route(message)
    expect(match?.tool.name).toBe('device.music_control')
    expect(match?.input).toEqual({ control: expected })
  })

  it('acota los valores: como mucho 10 minutos y volumen 100', () => {
    expect(parse('/seek 9999')).toEqual({ action: 'seek', seconds: 600 })
    expect(parse('adelanta 20 minutos')).toEqual({ action: 'seek', seconds: 600 })
    expect(parse('/volume 250')).toEqual({ action: 'volume', volume: 100 })
    expect(parse('/seek 0')).toBeNull()
    expect(parse('/volumen +0')).toBeNull()
  })

  it('no captura frases que no son de la música ni la orden de buscar', () => {
    for (const message of [
      'pausa de 10 minutos',
      'para mañana recuérdame pagar',
      'el siguiente pedido',
      'sube el precio',
      'qué suena mejor',
    ]) {
      expect(parse(message), message).toBeNull()
      expect(route(message)?.tool.name, message).not.toBe('device.music_control')
    }
    expect(route('/music numb linkin park')?.tool.name).toBe('device.play_music')
    expect(route('/play numb')?.tool.name).toBe('device.play_music')
  })

  it('pide permiso para controlar el navegador del equipo', () => {
    const denied = matchTool('pausa la música', [P.LUMI_USE], {
      now: NOW,
      timezone: 'America/Bogota',
    })
    expect(denied?.tool.name).toBe('device.music_control')
    expect(denied?.denied).toBe(true)
  })

  it('con el selector, los números salen del mensaje; del modelo solo una acción sin números', () => {
    const tool = DEVICE_TOOLS.find((t) => t.name === 'device.music_control')!
    const ctx = { now: NOW, timezone: 'America/Bogota' }
    expect(
      tool.selector!.fromArgs({ accion: 'pausa' }, normalizeText('adelanta 30 segundos'), ctx),
    ).toEqual({
      input: { control: { action: 'seek', seconds: 30 }, device: undefined },
    })
    expect(
      tool.selector!.fromArgs({ accion: 'siguiente', equipo: 'PC' }, 'cambia esto', ctx),
    ).toEqual({
      input: { control: { action: 'next' }, device: 'PC' },
    })
    expect(tool.selector!.fromArgs({ accion: 'volumen 100' }, 'algo', ctx)).toEqual({
      missing: ['accion'],
    })
  })
})

/* ───────────────────────── Contrato con el agente ───────────────────────── */

describe('browser.media.control: esquema estricto como el del agente', () => {
  const schema = DESKTOP_OPERATIONS['browser.media.control']!
  it('acepta cada acción con exactamente sus argumentos', () => {
    for (const args of [
      { action: 'pause' },
      { action: 'status' },
      { action: 'seek', seconds: -30 },
      { action: 'volume', volume: 0 },
      { action: 'volume', change: 10 },
    ]) {
      expect(schema.args.safeParse(args).success, JSON.stringify(args)).toBe(true)
    }
    for (const args of [
      { action: 'seek' },
      { action: 'seek', seconds: 0 },
      { action: 'seek', seconds: 601 },
      { action: 'volume' },
      { action: 'volume', volume: 10, change: 5 },
      { action: 'pause', seconds: 3 },
      { action: 'shutdown' },
      { action: 'pause', script: 'x' },
    ]) {
      expect(schema.args.safeParse(args).success, JSON.stringify(args)).toBe(false)
    }
    expect(schema.permission).toBe(P.DESKTOP_BROWSER_CONTROL)
    expect(schema.summarize({ action: 'seek', seconds: 30 })).toEqual({
      action: 'seek',
      seconds: 30,
    })
  })

  it('la orden reconocida se convierte en argumentos válidos', () => {
    for (const message of [
      'pausa',
      'adelanta 30 segundos',
      'sube el volumen',
      'volumen al 50',
      '/next',
    ]) {
      expect(schema.args.safeParse(controlArgs(parse(message)!)).success, message).toBe(true)
    }
  })
})

/* ───────────────────────── Ejecución ───────────────────────── */

interface Sent {
  operation: string
  args: Record<string, unknown>
}

function setup(outcome: LumiDesktopOutcome, operations = ['browser.media.control']) {
  const sent: Sent[] = []
  const device: LumiDesktopDevice = {
    id: 'dev_1',
    name: 'PC de Diego',
    online: true,
    paused: false,
    operations,
  }
  const port: LumiDesktopPort = {
    devices: async () => [device],
    async execute({ operation, args }) {
      sent.push({ operation, args })
      return outcome
    },
    isApproved: async () => false,
    approve: async () => undefined,
    savePending: async () => ({ id: 'x', expiresAt: NOW }),
    takePending: async () => null,
  }
  const none = async () => []
  const ctx: LumiToolContext = {
    userId: 'u1',
    permissionKeys: ALL,
    now: NOW,
    timezone: 'America/Bogota',
    deps: {
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
      desktop: port,
    },
  }
  const run = async (message: string) => {
    const match = route(message)!
    return match.tool.run(ctx, match.input as never)
  }
  return { sent, run }
}

const done = (result: Record<string, unknown>): LumiDesktopOutcome => ({
  status: 'completed',
  result,
  error: null,
})
const failed = (code: string): LumiDesktopOutcome => ({
  status: 'failed',
  result: null,
  error: { code, message: 'x' },
})
const TITLE = 'Numb (Official Music Video) [4K UPGRADE] – Linkin Park'

describe('controles de música: ejecución en el equipo', () => {
  it('envía la orden al agente sin pedir confirmación y responde con lo verificado', async () => {
    const { sent, run } = setup(
      done({ action: 'pause', title: TITLE, paused: true, already: false }),
    )
    const reply = await run('pausa la música')
    expect(sent).toEqual([{ operation: 'browser.media.control', args: { action: 'pause' } }])
    expect(reply.text).toBe(`Pausé «${TITLE}» en «PC de Diego».`)
  })

  it('cada acción tiene su texto, con la posición y el volumen que confirmó el reproductor', () => {
    const device = 'PC'
    expect(controlReply({ action: 'next' }, { title: 'In the End' }, device)).toBe(
      'Ahora suena «In the End» en «PC».',
    )
    expect(controlReply({ action: 'previous' }, { title: 'Numb' }, device)).toBe(
      'Volví a «Numb» en «PC»; está sonando.',
    )
    expect(
      controlReply({ action: 'seek', seconds: -20 }, { title: 'Numb', position_s: 71.4 }, device),
    ).toBe('Retrocedí 20 s: «Numb» va por 1:11 en «PC».')
    expect(
      controlReply(
        { action: 'volume', change: 10 },
        { title: 'Numb', volume: 40, from: 30 },
        device,
      ),
    ).toBe('Volumen del reproductor al 40 % en «PC» (antes 30 %).')
    expect(controlReply({ action: 'volume', volume: 0 }, { volume: 0, from: 40 }, device)).toBe(
      'Silencié la música en «PC» (antes 40 %).',
    )
    expect(
      controlReply(
        { action: 'status' },
        { title: 'Numb', position_s: 65, duration_s: 187, volume: 40, paused: false },
        device,
      ),
    ).toBe('Está sonando «Numb» en «PC» (1:05 de 3:07, volumen 40 %).')
    expect(controlReply({ action: 'status' }, { title: 'Numb', ad: true }, device)).toBe(
      'Ahora mismo suena un anuncio de YouTube antes de «Numb» en «PC».',
    )
    expect(controlReply({ action: 'resume' }, { title: 'Numb', already: true }, device)).toBe(
      '«Numb» ya estaba sonando en «PC».',
    )
  })

  it.each([
    ['NO_MEDIA_TAB', /no hay música sonando.*\/music/],
    ['AD_PLAYING', /anuncio de YouTube/],
    ['NO_NEXT_VIDEO', /no ofrece una canción siguiente/],
    ['NO_PREVIOUS_VIDEO', /no hay una canción anterior/],
    ['VERIFICATION_FAILED', /no puedo confirmar que se aplicó/],
  ])('un fallo %s se explica sin afirmar que se hizo', async (code, text) => {
    const { run } = setup(failed(code))
    const reply = await run('siguiente canción')
    expect(reply.text).toMatch(/^No pude: /)
    expect(reply.text).toMatch(text)
    expect(reply.rows).toBe(0)
  })

  it('con un agente sin controles no envía nada', async () => {
    const { sent, run } = setup(done({}), ['browser.media.play'])
    const reply = await run('/next')
    expect(sent).toEqual([])
    expect(reply.text).not.toMatch(/^Ahora suena/)
  })
})

/**
 * Servidor de desarrollo del Lumia Desktop Agent: rutas del agente (registro y WebSocket) y servicio
 * de ejecuciones con almacenamiento en memoria, sin MongoDB ni Redis. Sirve para probar el agente en
 * local y para las pruebas de extremo a extremo del repositorio lumia-desktop-agent.
 *
 *   npx tsx scripts/desktop-agent-dev-server.ts [--port 3901] [--revoke-after-ms 40000]
 *     [--drop-after-ms 5000] [--scenario browser [--scenario-delay-ms 15000]]
 *
 * --revoke-after-ms revoca el primer equipo que se conecta; --drop-after-ms corta todas las
 * conexiones una vez (como un reinicio del Server) para probar la reconexión; --scenario browser
 * ordena al primer equipo que anuncie el navegador una secuencia de operaciones sobre páginas de
 * prueba servidas aquí mismo (/demo/*) e imprime `SCENARIO PASSED` o `SCENARIO FAILED`.
 * --scenario chat recorre las herramientas de Lumi Chat del equipo (fase 4) con el navegador real:
 * confirmaciones, «no», «sí, no vuelvas a preguntar» y aprobaciones por tipo + destino.
 * --scenario desktop hace lo mismo con una aplicación nativa abierta en el equipo (por defecto la
 * app de prueba `LumiaTestApp.exe` de lumia-desktop-agent/tests/desktop; --desktop-app otra).
 * --scenario music pone música de YouTube con `browser.media.play` (necesita internet): búsqueda,
 * tarjeta, elección con sus estados, doble clic, pestaña reutilizada, corte de conexión durante la
 * reproducción y vídeo no disponible.
 *
 * Imprime `ENROLLMENT_CODE=<código>` al arrancar (propietario ficticio `dev-user`). La clave de
 * grants es efímera. No usar en producción: no hay sesión de usuario ni persistencia.
 */
import Fastify from 'fastify'
import {
  DEVICE_TOOLS,
  handleDesktopReply,
  playMusicSelection,
  resolveDesktopReply,
} from '../src/modules/lumi/tools/desktop.tools.js'
import { MusicCandidatesStore } from '../src/modules/lumi/music/candidates-store.js'
import { matchTool } from '../src/modules/lumi/tools/catalog.js'
import {
  selectMusicCandidate,
  type MusicPlaybackEvent,
} from '../src/modules/lumi/music/music-selection.js'
import type { TaskStage } from '../src/modules/lumi/desktop-agent/domain/protocol.js'
import type { LumiToolContext } from '../src/modules/lumi/tools/tool.types.js'
import { PERMISSION_REGISTRY as P, type PermissionId } from '../src/common/permissions/registry.js'
import { assembleDesktopAgentServices } from '../src/modules/lumi/desktop-agent/index.js'
import {
  MemoryDesktopDeviceStore,
  MemoryDesktopEnrollmentStore,
  MemoryPendingRegistrationStore,
} from '../src/modules/lumi/desktop-agent/infrastructure/desktop-device.repository.js'
import { MemoryDesktopExecutionStore } from '../src/modules/lumi/desktop-agent/infrastructure/desktop-execution.repository.js'
import { MemoryDesktopApprovalStore } from '../src/modules/lumi/desktop-agent/infrastructure/desktop-approval.repository.js'
import { GrantSigner } from '../src/modules/lumi/desktop-agent/infrastructure/grant-signer.js'
import { MemoryPendingActions } from '../src/modules/lumi/actions/pending-action.js'
import { DesktopEnrollmentService } from '../src/modules/lumi/desktop-agent/services/enrollment.service.js'
import { registerDesktopAgentDeviceRoutes } from '../src/routes/lumi-desktop-agent.routes.js'

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const port = Number(arg('port') ?? 3901)
const revokeAfterMs = arg('revoke-after-ms') ? Number(arg('revoke-after-ms')) : null
const dropAfterMs = arg('drop-after-ms') ? Number(arg('drop-after-ms')) : null
const scenario = arg('scenario') ?? null
/** Espera antes de lanzar el escenario (p. ej. para que otro proceso del mismo equipo tome la conexión). */
const scenarioDelayMs = Number(arg('scenario-delay-ms') ?? 0)
/** Aplicación de prueba para `--scenario desktop` (debe estar abierta en el equipo). */
const desktopApp = arg('desktop-app') ?? 'LumiaTestApp.exe'
/** Orden de chat exacta para `--scenario music` (se interpreta como en Lumi Chat). */
const musicCommand = arg('music-command') ?? '/music linkin park numb'
const owner = 'dev-user'
const base = `http://127.0.0.1:${port}`

const log = {
  info: (obj: object, msg: string) => console.log(`[server] ${msg} ${JSON.stringify(obj)}`),
  warn: (obj: object, msg: string) => console.log(`[server] WARN ${msg} ${JSON.stringify(obj)}`),
}

const devices = new MemoryDesktopDeviceStore()
const executions = new MemoryDesktopExecutionStore()
const enrollment = new DesktopEnrollmentService({
  devices,
  enrollments: new MemoryDesktopEnrollmentStore(),
  registrations: new MemoryPendingRegistrationStore(),
})
const services = assembleDesktopAgentServices({
  devices,
  executions,
  enrollment,
  signer: GrantSigner.fromEnv(undefined, 'development', log),
  approvals: new MemoryDesktopApprovalStore(),
  pending: new MemoryPendingActions(),
  log,
})
const { gateway, execution } = services

const FORM = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Formulario de prueba</title></head>
<body><h1>Prueba del agente</h1><label>Nombre <input id="nombre"></label>
<button onclick="location.href='/demo/gracias?n='+encodeURIComponent(document.getElementById('nombre').value)">Enviar</button>
<div style="height:3000px"></div></body></html>`
const THANKS = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Gracias</title></head><body><p>Recibido</p></body></html>`

const app = Fastify()
await app.register(
  async (api) =>
    registerDesktopAgentDeviceRoutes(api, {
      enrollment,
      gateway,
      devices,
      clientIp: (r) => r.ip,
    }),
  { prefix: '/api' },
)
app.get('/demo/form', async (_req, reply) => reply.type('text/html; charset=utf-8').send(FORM))
app.get('/demo/gracias', async (_req, reply) => reply.type('text/html; charset=utf-8').send(THANKS))
await app.listen({ host: '127.0.0.1', port })

const { code } = await enrollment.createEnrollment(owner)
console.log(`LISTENING=${base}`)
console.log(`ENROLLMENT_CODE=${code}`)

const CONTROL: PermissionId[] = [P.ADMIN_ACCESS, P.DESKTOP_BROWSER_READ, P.DESKTOP_BROWSER_CONTROL]
const READ_ONLY: PermissionId[] = [P.ADMIN_ACCESS, P.DESKTOP_BROWSER_READ]

async function runBrowserScenario(deviceId: string) {
  let failures = 0
  const check = (ok: boolean, what: string) => {
    console.log(`[scenario] ${ok ? 'PASS' : 'FAIL'} ${what}`)
    if (!ok) failures += 1
  }
  const run = async (
    operation: string,
    args: Record<string, unknown> = {},
    keys = CONTROL,
    timeoutMs = 45_000,
  ) => {
    const out = await execution.dispatch({
      userId: owner,
      permissionKeys: keys,
      deviceId,
      operation,
      args,
      timeoutMs,
    })
    const shown = JSON.stringify(out.result ?? null)
    console.log(
      `[scenario] ${operation} → ${out.execution.status} verification=${JSON.stringify(out.execution.verification)} ` +
        `error=${out.execution.error?.code ?? null} result=${shown.length > 300 ? `${shown.slice(0, 300)}…` : shown}`,
    )
    return out
  }
  const result = (out: { result: unknown }) => (out.result ?? {}) as Record<string, unknown>

  try {
    const discover = await run('browser.discover')
    check(discover.execution.status === 'completed', 'discover lists browsers')

    const nav = await run('browser.navigate', { url: `${base}/demo/form` })
    check(
      nav.execution.status === 'completed' && result(nav).title === 'Formulario de prueba',
      'navigate verified by URL and title',
    )

    const snap = await run('browser.snapshot', { interactive: true })
    const refs = Object.entries(
      (result(snap).refs ?? {}) as Record<string, { role: string; name: string }>,
    )
    const field = refs.find(([, r]) => r.role === 'textbox' && r.name === 'Nombre')?.[0]
    const send = refs.find(([, r]) => r.role === 'button' && r.name === 'Enviar')?.[0]
    check(
      Boolean(field && send) && result(snap).content_trust === 'untrusted',
      'snapshot returns refs marked untrusted',
    )

    const fill = await run('browser.fill', { ref: field, value: '--headed Lumia' })
    check(
      fill.execution.status === 'completed' && fill.execution.verification?.verified === true,
      'fill verified by reading the field back',
    )

    const scroll = await run('browser.scroll', { direction: 'down', pixels: 400 })
    check(scroll.execution.status === 'completed', 'scroll verified by position')

    const click = await run('browser.click', { ref: send })
    check(
      click.execution.status === 'completed' && String(result(click).url).includes('/demo/gracias'),
      'click verified by navigation',
    )

    const stale = await run('browser.click', { ref: field })
    check(
      stale.execution.status === 'failed' && stale.execution.error?.code === 'ELEMENT_STALE',
      'old ref reported as ELEMENT_STALE',
    )

    const tabs = await run('browser.tabs.list')
    check(tabs.execution.status === 'completed', 'tabs listed')

    await execution
      .dispatch({
        userId: owner,
        permissionKeys: CONTROL,
        deviceId,
        operation: 'browser.navigate',
        args: { url: 'file:///C:/Windows/win.ini' },
      })
      .then(() => check(false, 'file:// URL refused by the server'))
      .catch((e: { statusCode?: number }) =>
        check(e.statusCode === 400, 'file:// URL refused by the server (400)'),
      )
    await execution
      .dispatch({
        userId: owner,
        permissionKeys: READ_ONLY,
        deviceId,
        operation: 'browser.navigate',
        args: { url: `${base}/demo/form` },
      })
      .then(() => check(false, 'read-only user cannot navigate'))
      .catch((e: { statusCode?: number }) =>
        check(e.statusCode === 403, 'read-only user cannot navigate (403)'),
      )
    await execution
      .dispatch({
        userId: 'otra-persona',
        permissionKeys: CONTROL,
        deviceId,
        operation: 'browser.discover',
        args: {},
      })
      .then(() => check(false, 'other users cannot use this device'))
      .catch((e: { statusCode?: number }) =>
        check(e.statusCode === 404, 'other users cannot use this device (404)'),
      )

    // Cancelación: una navegación que no termina (IP no enrutable) se cancela a los 1,5 s.
    const slow = run('browser.navigate', { url: 'https://10.255.255.1/' })
    await new Promise((r) => setTimeout(r, 1500))
    const open = (await executions.listOpenByDevice(deviceId))[0]
    if (open) await execution.cancel(open.id, owner, CONTROL)
    const cancelled = await slow
    check(cancelled.execution.status === 'cancelled', 'running navigation cancelled')

    const close = await run('browser.close_session')
    check(close.execution.status === 'completed', 'isolated browser closed')

    const stored = JSON.stringify([...executions.items.values()])
    check(
      !stored.includes('--headed Lumia') && !stored.includes('Recibido'),
      'audit records hold no typed values or page content',
    )
  } catch (error) {
    console.log(`[scenario] ERROR ${(error as Error).message}`)
    failures += 1
  }
  console.log(failures === 0 ? 'SCENARIO PASSED' : `SCENARIO FAILED (${failures})`)
}

const APPS: PermissionId[] = [P.ADMIN_ACCESS, P.DESKTOP_APPS_READ, P.DESKTOP_APPS_CONTROL]
const APPS_READ_ONLY: PermissionId[] = [P.ADMIN_ACCESS, P.DESKTOP_APPS_READ]

interface TreeNode {
  role?: string
  name?: string
  ref_id?: string
  children?: TreeNode[]
}

function findRef(node: TreeNode | undefined, role: string, name: string): string | undefined {
  if (!node) return undefined
  if (node.role === role && node.name === name && node.ref_id) return node.ref_id
  for (const child of node.children ?? []) {
    const found = findRef(child, role, name)
    if (found) return found
  }
  return undefined
}

async function runDesktopScenario(deviceId: string) {
  let failures = 0
  const check = (ok: boolean, what: string) => {
    console.log(`[scenario] ${ok ? 'PASS' : 'FAIL'} ${what}`)
    if (!ok) failures += 1
  }
  const run = async (operation: string, args: Record<string, unknown> = {}, keys = APPS) => {
    const out = await execution.dispatch({
      userId: owner,
      permissionKeys: keys,
      deviceId,
      operation,
      args,
      timeoutMs: 45_000,
    })
    const shown = JSON.stringify(out.result ?? null)
    console.log(
      `[scenario] ${operation} → ${out.execution.status} verification=${JSON.stringify(out.execution.verification)} ` +
        `error=${out.execution.error?.code ?? null} result=${shown.length > 240 ? `${shown.slice(0, 240)}…` : shown}`,
    )
    return out
  }
  const result = (out: { result: unknown }) => (out.result ?? {}) as Record<string, unknown>

  try {
    const status = await run('desktop.status')
    check(status.execution.status === 'completed', 'desktop status read')

    const apps = await run('desktop.list_applications')
    const listed = (
      (result(apps).applications ?? []) as Array<{ name: string; blocked: boolean }>
    ).find((a) => a.name === desktopApp)
    check(listed?.blocked === false, `${desktopApp} listed and allowed`)

    const windows = await run('desktop.list_windows')
    check(windows.execution.status === 'completed', 'windows listed')

    const snap = await run('desktop.snapshot', { app: desktopApp })
    const tree = result(snap).tree as TreeNode | undefined
    const field = findRef(tree, 'textfield', 'Nombre')
    const greet = findRef(tree, 'button', 'Saludar')
    const noop = findRef(tree, 'button', 'Sin efecto')
    check(
      Boolean(field && greet && noop) && result(snap).content_trust === 'untrusted',
      'snapshot refs marked untrusted',
    )

    const set = await run('desktop.set_value', { ref: field, value: '--force Lumia' })
    check(
      set.execution.status === 'completed' && set.execution.verification?.verified === true,
      'set_value verified',
    )

    const read = await run('desktop.get_value', { ref: field })
    check(result(read).value === '--force Lumia', 'get_value reads it back')

    const none = await run('desktop.click', { ref: noop })
    check(
      none.execution.status === 'unverified',
      'click without visible effect reported unverified',
    )

    const clicked = await run('desktop.click', { ref: greet })
    check(clicked.execution.status === 'completed', 'click verified by UI change')

    const full = await run('desktop.snapshot', { app: desktopApp, interactive: false })
    check(
      JSON.stringify(result(full).tree).includes('Hola, --force Lumia'),
      'label shows the greeting',
    )

    const blocked = await run('desktop.snapshot', { app: 'cmd.exe' })
    check(
      blocked.execution.status === 'rejected' &&
        blocked.execution.error?.code === 'APPLICATION_BLOCKED',
      'terminal refused by the agent policy',
    )
    await execution
      .dispatch({
        userId: owner,
        permissionKeys: APPS,
        deviceId,
        operation: 'desktop.press_key',
        args: { app: desktopApp, key: 'win+r' },
      })
      .then(() => check(false, 'win+r refused by the server'))
      .catch((e: { statusCode?: number }) =>
        check(e.statusCode === 400, 'win+r refused by the server (400)'),
      )
    await execution
      .dispatch({
        userId: owner,
        permissionKeys: APPS_READ_ONLY,
        deviceId,
        operation: 'desktop.click',
        args: { ref: greet },
      })
      .then(() => check(false, 'read-only user cannot click'))
      .catch((e: { statusCode?: number }) =>
        check(e.statusCode === 403, 'read-only user cannot click (403)'),
      )

    const stored = JSON.stringify([...executions.items.values()])
    check(
      !stored.includes('--force Lumia') && !stored.includes('Hola,'),
      'audit records hold no typed values or window content',
    )
  } catch (error) {
    console.log(`[scenario] ERROR ${(error as Error).message}`)
    failures += 1
  }
  console.log(failures === 0 ? 'SCENARIO PASSED' : `SCENARIO FAILED (${failures})`)
}

const CHAT_KEYS: PermissionId[] = [
  P.LUMI_USE,
  P.DESKTOP_DEVICES_READ,
  P.DESKTOP_BROWSER_READ,
  P.DESKTOP_BROWSER_CONTROL,
  P.DESKTOP_APPS_READ,
  P.DESKTOP_APPS_CONTROL,
]

function chatContext(): LumiToolContext {
  const none = async () => []
  return {
    userId: owner,
    permissionKeys: CHAT_KEYS,
    now: new Date(),
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
      desktop: services.lumiPort,
    },
  }
}

/** Lo mismo que hace Lumi Chat: herramientas `device.*` y respuestas «sí»/«no», sin modelo. */
async function runChatScenario() {
  let failures = 0
  const check = (ok: boolean, what: string) => {
    console.log(`[scenario] ${ok ? 'PASS' : 'FAIL'} ${what}`)
    if (!ok) failures += 1
  }
  const ctx = chatContext()
  const tool = (name: string) => DEVICE_TOOLS.find((t) => t.name === name)!
  const say = async (name: string, input: Record<string, unknown>) => {
    const out = await tool(name).run(ctx, input)
    console.log(
      `[chat] ${name} ${JSON.stringify(input)}\n       → ${out.text.replace(/\n/g, '\n         ')}`,
    )
    return out.text
  }
  const reply = async (message: string) => {
    const out = (await handleDesktopReply(ctx, message)) ?? '(sin acción pendiente)'
    console.log(`[chat] «${message}»\n       → ${out.replace(/\n/g, '\n         ')}`)
    return out
  }
  const form = `${base}/demo/form`
  try {
    check(
      (await say('device.status', {})).includes('conectado'),
      'status lists the connected device',
    )
    check(
      (await say('device.open_page', { url: form })).startsWith('Voy a abrir'),
      'first open asks for confirmation',
    )
    check((await reply('no')).startsWith('De acuerdo, no hice nada'), '«no» does nothing')
    check(
      (await say('device.open_page', { url: form })).startsWith('Voy a abrir'),
      'after «no» it asks again',
    )
    const remembered = await reply('sí, no vuelvas a preguntar')
    check(
      remembered.startsWith('Abrí') && remembered.includes('No volveré a pedirte confirmación'),
      '«sí, no vuelvas a preguntar» opens and remembers',
    )
    check(
      (await say('device.open_page', { url: `${form}?otra=1` })).startsWith('Abrí'),
      'same site opens without asking',
    )
    check(
      (await say('device.read_page', {})).includes('botón «Enviar»'),
      'read_page lists the elements',
    )
    check(
      (await say('device.type_page', { text: 'Lumia', field: 'Nombre' })).startsWith(
        'Voy a escribir',
      ),
      'typing is a different kind: asks',
    )
    check((await reply('sí')).startsWith('Escribí el texto en «Nombre»'), '«sí» types and verifies')
    check(
      (await say('device.click_page', { element: 'enviar' })).startsWith('Voy a pulsar «Enviar»'),
      'click asks with the real element name',
    )
    check((await reply('sí')).startsWith('Pulsé «Enviar»'), '«sí» clicks and verifies')
    const other = `http://localhost:${port}/demo/form`
    check(
      (await say('device.open_page', { url: other })).startsWith('Voy a abrir'),
      'another site asks again',
    )
    await reply('no')
    const stored = JSON.stringify([...executions.items.values()])
    check(
      !stored.includes('Lumia') || !stored.includes('"value"'),
      'audit records hold no typed value',
    )
    await execution.dispatch({
      userId: owner,
      permissionKeys: CONTROL,
      deviceId: [...devices.items.keys()][0]!,
      operation: 'browser.close_session',
      args: {},
    })
  } catch (error) {
    console.log(`[scenario] ERROR ${(error as Error).message}`)
    failures += 1
  }
  console.log(failures === 0 ? 'SCENARIO PASSED' : `SCENARIO FAILED (${failures})`)
}


/** Estados de éxito en orden: los eventos de una reproducción solo pueden avanzar. */
const MUSIC_ORDER = [
  'RECEIVED',
  'VALIDATED',
  'BROWSER_READY',
  'TAB_READY',
  'NAVIGATING',
  'NAVIGATION_COMPLETED',
  'PLAYING',
  'MINIMIZING',
  'COMPLETED',
]

async function runMusicScenario(deviceId: string) {
  let failures = 0
  const check = (ok: boolean, what: string) => {
    console.log(`[scenario] ${ok ? 'PASS' : 'FAIL'} ${what}`)
    if (!ok) failures += 1
  }
  const ctx = chatContext()
  const store = new MusicCandidatesStore(null)
  const deps = { store, play: playMusicSelection }
  const mediaRuns = () =>
    [...executions.items.values()].filter((e) => e.operation === 'browser.media.play').length
  const tool = (name: string) => DEVICE_TOOLS.find((t) => t.name === name)!
  const ordered = (events: MusicPlaybackEvent[]) => {
    const ranks = events.map((e) => MUSIC_ORDER.indexOf(e.state)).filter((r) => r >= 0)
    return ranks.every((r, i) => i === 0 || r > ranks[i - 1]!)
  }
  const select = async (queryId: string, candidateId: string, messageId: string) => {
    const events: MusicPlaybackEvent[] = []
    const out = await selectMusicCandidate(
      deps,
      ctx,
      { queryId, candidateId, conversationId: 'conv-e2e', messageId },
      (e) => {
        events.push(e)
        console.log(`[music] ${messageId} ${e.state}${e.stage ? ` (${e.stage})` : ''}`)
      },
    )
    console.log(`[music] ${messageId} → ${out.status} ${out.state} replayed=${out.replayed} «${out.message}»`)
    return { out, events }
  }

  try {
    // 1. La orden exacta del chat, interpretada como en Lumi Chat; confirmación, «sí» y tarjeta.
    const match = matchTool(musicCommand, CHAT_KEYS, { now: new Date(), timezone: 'America/Bogota' })
    console.log(`[chat] «${musicCommand}» → ${match?.tool.name} ${JSON.stringify(match?.input)}`)
    check(match?.tool.name === 'device.play_music', 'the chat command selects device.play_music')
    const card = await tool('device.play_music').run(ctx, (match?.input ?? {}) as Record<string, unknown>)
    check(Boolean(card.confirmation), 'play_music asks for confirmation first')
    const answer = await resolveDesktopReply(ctx, 'sí, no vuelvas a preguntar', card.confirmation?.id)
    console.log(`[chat] → ${answer?.text}`)
    const selection = answer?.musicSelection
    check(Boolean(selection?.candidates.length), 'the search returns candidates for the card')
    if (selection) {
      await store.store(owner, selection)
      await store.attachConversation(owner, selection.queryId, 'conv-e2e')
      const urls = selection.candidates.map((c) => c.url)
      console.log(`[music] candidates: ${JSON.stringify(selection.candidates.map((c) => [c.title, c.url]))}`)
      check(
        urls.some((u) => u) &&
          urls.every((u) => u === null || /^https:\/\/www\.youtube\.com\/watch\?v=[\w-]{11}$/.test(u ?? '')),
        'candidates carry canonical YouTube URLs from the snapshot',
      )
      // Lo que elegiría la persona: «Numb (Official Music Video)».
      const first = selection.candidates.find((c) => /official/i.test(c.title)) ?? selection.candidates[0]!
      console.log(`[music] chosen: ${first.title} ${first.url}`)
      check(Boolean(first.videoId) && first.url === `https://www.youtube.com/watch?v=${first.videoId}`, 'chosen candidate keeps videoId == URL')
      const before = mediaRuns()
      const played = await select(selection.queryId, first.id, 'm-card-1')
      check(['playing', 'partial'].includes(played.out.status), 'selection plays the chosen video')
      check(
        played.out.state === 'COMPLETED' || played.out.state === 'MINIMIZE_FAILED',
        `final state is COMPLETED or MINIMIZE_FAILED (${played.out.state})`,
      )
      check(ordered(played.events), 'states only move forward')
      check(
        played.events.every(
          (e) =>
            e.queryId === selection.queryId &&
            e.candidateId === first.id &&
            e.messageId === 'm-card-1' &&
            e.conversationId === 'conv-e2e' &&
            e.deviceId === deviceId,
        ),
        'every event carries the ids of the card that asked',
      )
      check(
        played.events.some((e) => e.stage === 'tab.reused' || e.stage === 'tab.created'),
        'tab stage reported',
      )
      check(mediaRuns() === before + 1, 'exactly one browser.media.play for the selection')

      // Doble clic: el mismo candidato otra vez no se repite.
      const again = await select(selection.queryId, first.id, 'm-card-1')
      check(again.out.replayed && mediaRuns() === before + 1, 'second click returns the result without replaying')

      // Dos clics simultáneos en otro candidato: uno se ejecuta, el otro es «busy».
      const other = selection.candidates[1]
      if (other) {
        const [a, b] = await Promise.all([
          select(selection.queryId, other.id, 'm-card-1'),
          select(selection.queryId, other.id, 'm-card-1'),
        ])
        const statuses = [a.out.status, b.out.status].sort()
        check(statuses.includes('busy') && mediaRuns() === before + 2, 'simultaneous double click runs once')
        const executed = a.out.status === 'busy' ? b.out : a.out
        check(['playing', 'partial'].includes(executed.status), `second candidate plays too (${executed.state})`)
        const reused = [...a.events, ...b.events].some((e) => e.stage === 'tab.reused')
        check(reused, 'second playback reuses the Lumia tab')
      }
    }

    // 2. Corte de conexión durante la reproducción: el resultado llega tras la reconexión.
    const stages: TaskStage[] = []
    const dispatch = execution.dispatch({
      userId: owner,
      permissionKeys: CONTROL,
      deviceId,
      operation: 'browser.media.play',
      args: { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
      timeoutMs: 60_000,
      onStage: (s) => {
        stages.push(s)
        console.log(`[music] reconnect stage ${s}`)
      },
    })
    setTimeout(() => {
      gateway.shutdown()
      console.log('[server] DROPPED all connections during playback')
    }, 2_500)
    const afterDrop = await dispatch
    console.log(
      `[music] reconnect → ${afterDrop.execution.status} ${JSON.stringify(afterDrop.result)} error=${afterDrop.execution.error?.code ?? null}`,
    )
    check(
      afterDrop.execution.status === 'completed' &&
        ['COMPLETED', 'MINIMIZE_FAILED'].includes(String((afterDrop.result as { state?: unknown })?.state)),
      'playback result arrives after the agent reconnects',
    )
    await new Promise((r) => setTimeout(r, 1_000))
    check(gateway.isOnline(deviceId), 'agent is online again')

    // 3. Vídeo no disponible.
    const missing = await execution.dispatch({
      userId: owner,
      permissionKeys: CONTROL,
      deviceId,
      operation: 'browser.media.play',
      args: { url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa' },
      timeoutMs: 60_000,
    })
    check(missing.execution.error?.code === 'VIDEO_UNAVAILABLE', 'unavailable video → VIDEO_UNAVAILABLE')

    // 4. URL ajena: el Server no la firma.
    const foreign = await execution
      .dispatch({
        userId: owner,
        permissionKeys: CONTROL,
        deviceId,
        operation: 'browser.media.play',
        args: { url: 'https://evil.example/watch?v=dQw4w9WgXcQ' },
      })
      .then(
        () => 'dispatched',
        (e: { statusCode?: number }) => String(e.statusCode),
      )
    check(foreign === '400', 'foreign URL refused by the Server (400)')

    // 5. Pestañas al terminar: ninguna vacía y sin cerrar ninguna.
    const tabs = await execution.dispatch({
      userId: owner,
      permissionKeys: CONTROL,
      deviceId,
      operation: 'browser.tabs.list',
      args: {},
    })
    const list = ((tabs.result as { tabs?: Array<{ url: string }> })?.tabs ?? []).map((t) => t.url)
    console.log(`[music] tabs at the end: ${JSON.stringify(list)}`)
    check(!list.some((u) => u === 'about:blank' || u === ''), 'no empty about:blank tab left')

    await execution.dispatch({
      userId: owner,
      permissionKeys: CONTROL,
      deviceId,
      operation: 'browser.close_session',
      args: {},
    })
  } catch (error) {
    console.log(`[scenario] ERROR ${(error as Error).message}`)
    failures += 1
  }
  console.log(failures === 0 ? 'SCENARIO PASSED' : `SCENARIO FAILED (${failures})`)
}

let revokeScheduled = false
let dropScheduled = false
let scenarioStarted = false
const seen = new Map<string, string>()
setInterval(() => {
  for (const device of devices.items.values()) {
    const state = `${device.status}|${gateway.isOnline(device.id)}|${device.execution}|${JSON.stringify(device.capabilities)}`
    if (seen.get(device.id) !== state) {
      seen.set(device.id, state)
      console.log(
        `[device] ${device.id} status=${device.status} online=${gateway.isOnline(device.id)} execution=${device.execution} ` +
          `os=${device.os} arch=${device.arch} agent=${device.agentVersion} capabilities=${JSON.stringify(device.capabilities)}`,
      )
    }
    if (dropAfterMs !== null && !dropScheduled && gateway.isOnline(device.id)) {
      dropScheduled = true
      setTimeout(() => {
        // Como un reinicio del Server: se cierran los sockets (4503) pero los datos se conservan.
        gateway.shutdown()
        console.log(`[server] DROPPED all connections`)
      }, dropAfterMs)
    }
    if (revokeAfterMs !== null && !revokeScheduled && gateway.isOnline(device.id)) {
      revokeScheduled = true
      setTimeout(async () => {
        await devices.revoke(device.id, owner, new Date())
        gateway.disconnectRevoked(device.id)
        console.log(`[device] ${device.id} REVOKED`)
      }, revokeAfterMs)
    }
    const ready =
      (scenario === 'browser' && device.capabilities?.operations.includes('browser.navigate')) ||
      (scenario === 'desktop' && device.capabilities?.operations.includes('desktop.snapshot')) ||
      (scenario === 'chat' && device.capabilities?.operations.includes('browser.navigate')) ||
      (scenario === 'music' && device.capabilities?.operations.includes('browser.media.play'))
    if (ready && !scenarioStarted && gateway.isOnline(device.id)) {
      scenarioStarted = true
      const id = device.id
      setTimeout(() => {
        if (!gateway.isOnline(id)) console.log('SCENARIO FAILED (device offline after delay)')
        else if (scenario === 'desktop') void runDesktopScenario(id)
        else if (scenario === 'chat') void runChatScenario()
        else if (scenario === 'music') void runMusicScenario(id)
        else void runBrowserScenario(id)
      }, scenarioDelayMs)
    }
  }
}, 250)

const stop = async () => {
  services.shutdown()
  await app.close()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)

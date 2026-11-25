import { PERMISSION_REGISTRY, type PermissionId } from '../../../common/permissions/registry.js'
import { isConfirmation, isRejection, normalizeText } from '../automation/domain/reminder-parser.js'
import { plainText } from '../selector/selector-text.js'
import type {
  LumiDesktopApproval,
  LumiDesktopDevice,
  LumiDesktopOutcome,
  LumiSelectorArg,
  LumiSelectorBuild,
  LumiTool,
  LumiToolContext,
  LumiToolName,
  LumiToolResult,
} from './tool.types.js'

/**
 * Equipos de escritorio en Lumi Chat (Lumia Desktop Agent). Herramientas externas: su texto es la
 * respuesta final y el contenido de páginas o ventanas NUNCA pasa al modelo (podría contener
 * instrucciones maliciosas). El Server firma cada operación con los permisos del usuario.
 *
 * Las acciones (abrir, pulsar, escribir) piden confirmación la primera vez para cada tipo y destino
 * (sitio o aplicación) en cada equipo. «sí, no vuelvas a preguntar» recuerda la aprobación; «sí» la
 * ejecuta una vez; «no» la descarta y la próxima vez se vuelve a preguntar.
 */

type DeviceInput = {
  device?: string
  url?: string
  element?: string
  text?: string
  field?: string
  app?: string
  /** Canción o artista a poner en YouTube (`device.play_music`). */
  query?: string
}

const NAME_MAX = 120
const TEXT_MAX = 2000
const LIST_MAX = 40

const NO_PORT_TEXT = 'Los equipos de escritorio no están activados en Lumia.'

/** Respuesta cuando el selector no encuentra la orden del equipo (no es una capacidad de la tienda). */
export const DEVICE_HELP_REPLY =
  'Con tus equipos puedo decirte si están conectados, abrir una página, leer la página abierta, pulsar un botón o escribir en un campo de la página, ver qué aplicaciones tienes abiertas, leer una aplicación y pulsar o escribir en ella. Por ejemplo: «Abre example.com en mi PC» o «¿Qué aplicaciones tengo abiertas?».'

/* ───────────────────────── Texto y argumentos ───────────────────────── */

function clean(value: unknown, max = NAME_MAX): string | null {
  if (typeof value !== 'string') return null
  const text = value.replace(/\s+/g, ' ').trim()
  return text ? text.slice(0, max) : null
}

/** URL http(s) a partir de lo que dice el usuario («google.com», «https://x.org/a»). */
export function normalizeUrl(raw: string | null): string | null {
  if (!raw) return null
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  try {
    const url = new URL(candidate)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(url.hostname) && url.hostname !== 'localhost') return null
    return url.toString()
  } catch {
    return null
  }
}

function hostOf(url: unknown): string | null {
  try {
    return new URL(String(url)).hostname.toLowerCase()
  } catch {
    return null
  }
}

const ROLE_LABEL: Record<string, string> = {
  button: 'botón',
  link: 'enlace',
  textbox: 'campo',
  textfield: 'campo',
  searchbox: 'buscador',
  combobox: 'lista',
  checkbox: 'casilla',
  radio: 'opción',
  menuitem: 'opción de menú',
  tab: 'pestaña',
  heading: 'título',
  listitem: 'elemento',
  treeitem: 'elemento',
}

const FIELD_ROLES = new Set(['textbox', 'textfield', 'searchbox', 'combobox', 'spinbutton'])

interface Element {
  ref: string
  role: string
  name: string
}

/** Elementos de un snapshot de navegador (`refs`: { e1: { role, name } }). */
function pageElements(result: Record<string, unknown> | null): Element[] {
  const refs = (result?.refs ?? {}) as Record<string, { role?: string; name?: string }>
  return Object.entries(refs).map(([ref, v]) => ({
    ref,
    role: String(v.role ?? ''),
    name: String(v.name ?? ''),
  }))
}

/** Elementos con ref de un árbol de accesibilidad de escritorio. */
function appElements(result: Record<string, unknown> | null): Element[] {
  const out: Element[] = []
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return
    const n = node as { ref_id?: string; role?: string; name?: string; children?: unknown[] }
    if (n.ref_id && n.name)
      out.push({ ref: n.ref_id, role: String(n.role ?? ''), name: String(n.name) })
    for (const child of n.children ?? []) walk(child)
  }
  walk(result?.tree)
  return out
}

type Resolution = { element: Element } | { reply: string }

/**
 * Elemento por su nombre visible: coincidencia exacta y, si no hay, parcial. Varios candidatos o
 * ninguno: se pregunta en lugar de adivinar.
 */
export function resolveElement(
  elements: Element[],
  wanted: string,
  kind: 'click' | 'field',
): Resolution {
  const target = plainText(wanted)
  const pool = kind === 'field' ? elements.filter((e) => FIELD_ROLES.has(e.role)) : elements
  const exact = pool.filter((e) => plainText(e.name) === target)
  const partial = exact.length
    ? exact
    : pool.filter((e) => target.length >= 2 && plainText(e.name).includes(target))
  if (partial.length === 1) return { element: partial[0]! }
  const describe = (e: Element) => `${ROLE_LABEL[e.role] ?? e.role} «${e.name}»`
  if (partial.length > 1) {
    return {
      reply: `Hay varios elementos que coinciden con «${wanted}»: ${partial
        .slice(0, 6)
        .map(describe)
        .join(', ')}. Dime cuál con su nombre completo.`,
    }
  }
  const names = pool
    .filter((e) => e.name)
    .slice(0, 8)
    .map(describe)
  return {
    reply: names.length
      ? `No encontré ${kind === 'field' ? 'un campo' : 'un elemento'} «${wanted}». Algunos disponibles: ${names.join(', ')}.`
      : `No encontré ${kind === 'field' ? 'campos' : 'elementos'} que se puedan usar ahí.`,
  }
}

/* ───────────────────────── Equipos y resultados ───────────────────────── */

type DeviceResolution = { device: LumiDesktopDevice } | { reply: string }

async function resolveDevice(
  ctx: LumiToolContext,
  name: string | undefined,
  operation: string,
): Promise<DeviceResolution> {
  const port = ctx.deps.desktop
  if (!port) return { reply: NO_PORT_TEXT }
  const devices = await port.devices(ctx.userId)
  if (devices.length === 0) {
    return { reply: 'No tienes equipos inscritos. Inscribe uno en Lumia Admin → Dispositivos.' }
  }
  let candidates = devices
  if (name) {
    const wanted = plainText(name)
    candidates = devices.filter(
      (d) => plainText(d.name) === wanted || plainText(d.name).includes(wanted),
    )
    if (candidates.length === 0) {
      return {
        reply: `No encontré el equipo «${name}». Tus equipos: ${devices.map((d) => `«${d.name}»`).join(', ')}.`,
      }
    }
  } else {
    const online = devices.filter((d) => d.online)
    if (online.length === 1) candidates = online
    else if (online.length === 0) {
      return {
        reply: `Ninguno de tus equipos está conectado (${devices.map((d) => `«${d.name}»`).join(', ')}).`,
      }
    }
  }
  if (candidates.length > 1) {
    return {
      reply: `¿En qué equipo? Tienes conectados: ${candidates.map((d) => `«${d.name}»`).join(', ')}.`,
    }
  }
  const device = candidates[0]!
  if (!device.online) return { reply: `«${device.name}» no está conectado.` }
  if (device.paused) return { reply: `La ejecución está en pausa en «${device.name}».` }
  if (!device.operations.includes(operation)) {
    const engine = operation.startsWith('browser.') ? 'el navegador' : 'las aplicaciones'
    return {
      reply: `«${device.name}» no puede usar ${engine} ahora mismo (motor no disponible o sin permiso de accesibilidad).`,
    }
  }
  return { device }
}

const ERROR_TEXT: Record<string, string> = {
  DEVICE_OFFLINE: 'el equipo no está conectado',
  DEVICE_PAUSED: 'la ejecución está en pausa en el equipo',
  DEVICE_REVOKED: 'el equipo fue revocado',
  OPERATION_NOT_SUPPORTED: 'el equipo no puede hacer eso ahora mismo',
  FORBIDDEN: 'no tienes permiso para eso',
  APPLICATION_BLOCKED:
    'Lumia nunca controla esa aplicación (terminales, herramientas del sistema, navegadores fuera del perfil de Lumia, gestores de contraseñas y acceso remoto están bloqueados)',
  APPLICATION_NOT_RUNNING: 'esa aplicación no está abierta',
  APPLICATION_NOT_FOCUSED: 'esa aplicación no está en primer plano',
  WINDOW_AMBIGUOUS: 'esa aplicación tiene varias ventanas abiertas',
  ELEMENT_STALE: 'la pantalla cambió mientras tanto; vuelve a pedirlo',
  ELEMENT_NOT_FOUND: 'el elemento ya no está en la pantalla',
  ELEMENT_NOT_ACTIONABLE: 'el elemento no se puede usar ahora (oculto o deshabilitado)',
  ELEMENT_AMBIGUOUS: 'hay varios elementos iguales y no sé cuál es',
  NAVIGATION_FAILED: 'no se pudo abrir esa página',
  VERIFICATION_FAILED: 'el resultado no coincide con lo pedido',
  ACCESSIBILITY_PERMISSION_MISSING: 'falta el permiso de accesibilidad en el equipo',
  ENGINE_UNAVAILABLE: 'el motor de automatización no está disponible en el equipo',
  SNAPSHOT_TOO_LARGE: 'la ventana tiene demasiados elementos para leerla entera',
  OPERATION_TIMEOUT: 'el equipo tardó demasiado en responder',
  NO_RESULT: 'el equipo no respondió a tiempo',
  CANCELLED: 'se canceló',
}

function failureText(outcome: LumiDesktopOutcome): string {
  const code = outcome.error?.code ?? outcome.status.toUpperCase()
  return `No se pudo: ${ERROR_TEXT[code] ?? `error ${code}`}.`
}

function ok(outcome: LumiDesktopOutcome): boolean {
  return outcome.status === 'completed'
}

/** Texto final para una acción: confirma lo verificado y es honesto con lo no verificado. */
function actionText(outcome: LumiDesktopOutcome, done: string): string {
  if (outcome.status === 'completed') return done
  if (outcome.status === 'unverified') {
    return `Lo hice, pero no pude comprobar que cambiara algo en la pantalla. Revísalo en el equipo.`
  }
  return failureText(outcome)
}

async function execute(
  ctx: LumiToolContext,
  device: LumiDesktopDevice,
  operation: string,
  args: Record<string, unknown>,
): Promise<LumiDesktopOutcome> {
  return ctx.deps.desktop!.execute({
    userId: ctx.userId,
    permissionKeys: ctx.permissionKeys,
    deviceId: device.id,
    operation,
    args,
  })
}

function result(text: string, rows = 1, extra: Partial<LumiToolResult> = {}): LumiToolResult {
  return { text, rows, ...extra }
}

/* ───────────────────────── Acciones con confirmación ───────────────────────── */

/**
 * `play_music` no es un tipo de aprobación propio: abre la búsqueda y pulsa un vídeo en YouTube, así
 * que necesita (y al recordarse, guarda) las aprobaciones `open_page` y `click_page` de ese sitio.
 */
type ActionKind = 'open_page' | 'click_page' | 'type_page' | 'click_app' | 'type_app' | 'play_music'

interface ActionPlan {
  kind: ActionKind
  deviceId: string
  deviceName: string
  /** Sitio (host) o aplicación: el destino de la aprobación. */
  target: string
  url?: string
  element?: string
  field?: string
  text?: string
  app?: string
  query?: string
}

const KIND_PHRASE: Record<ActionKind, string> = {
  open_page: 'abrir páginas de',
  click_page: 'pulsar en las páginas de',
  type_page: 'escribir en las páginas de',
  click_app: 'pulsar en',
  type_app: 'escribir en',
  play_music: 'abrir y pulsar en las páginas de',
}

/* ───────────────────────── Música en YouTube ───────────────────────── */

const YOUTUBE_HOST = 'www.youtube.com'
const MUSIC_QUERY_MAX = 200
/** «/music X», «/play X», «/reproduce X» (comandos del chat de Lumia Admin). */
const MUSIC_COMMAND = /^\/(?:play|reproduce|music)\s+(.+)$/i
/** Enlaces de anuncios o de la propia interfaz de YouTube que nunca se pulsan como vídeo. */
const NOT_A_VIDEO = /\b(?:patrocinado|sponsored|anuncio|publicidad|ad)\b/

export function youtubeSearchUrl(query: string): string {
  return `https://${YOUTUBE_HOST}/results?search_query=${encodeURIComponent(query)}`
}

/** Enlaces a un canal («Ir al canal Linkin Park», «Go to channel …»): nunca son el vídeo. */
const CHANNEL_LINK = /^(?:ir al canal|go to channel)\b/
/**
 * El título de un vídeo en los resultados lleva su duración en el nombre accesible
 * («… 3 minutos y 8 segundos», «… 3 minutes, 8 seconds»); los enlaces de canal no.
 */
const HAS_DURATION = /\b\d+ (?:segundos?|minutos?|horas?|seconds?|minutes?|hours?)\b/

/**
 * Vídeo de los resultados de búsqueda que mejor coincide con lo pedido: un enlace cuyo nombre
 * accesible contiene la mayoría de las palabras de la búsqueda. Se prefieren los títulos de vídeo
 * (con duración) a cualquier otro enlace que también coincida, como el nombre del canal. Si
 * empatan, el primero de la página (el más relevante para YouTube). null si ninguno coincide lo
 * suficiente: no se adivina.
 */
export function pickVideoLink(elements: Element[], query: string): Element | null {
  const terms = [
    ...new Set(
      plainText(query)
        .split(' ')
        .filter((w) => w.length >= 2),
    ),
  ]
  if (terms.length === 0) return null
  const needed = Math.ceil(terms.length / 2)
  let best: { element: Element; hits: number; video: boolean } | null = null
  for (const element of elements) {
    if (element.role !== 'link' || !element.name) continue
    const name = plainText(element.name)
    if (NOT_A_VIDEO.test(name) || CHANNEL_LINK.test(name)) continue
    const words = new Set(name.split(' '))
    const hits = terms.filter((t) => words.has(t)).length
    if (hits < needed) continue
    const video = HAS_DURATION.test(name)
    const better = !best || (video && !best.video) || (video === best.video && hits > best.hits)
    if (better) best = { element, hits, video }
  }
  return best?.element ?? null
}

function summarize(plan: ActionPlan): string {
  const preview = (plan.text ?? '').length > 40 ? `${plan.text!.slice(0, 40)}…` : plan.text
  switch (plan.kind) {
    case 'play_music':
      return `buscar «${plan.query}» en YouTube y poner el vídeo que coincida`
    case 'open_page':
      return `abrir ${plan.url}`
    case 'click_page':
      return `pulsar «${plan.element}» en ${plan.target}`
    case 'type_page':
      return `escribir «${preview}» en el campo «${plan.field}» de ${plan.target}`
    case 'click_app':
      return `pulsar «${plan.element}» en ${plan.app}`
    case 'type_app':
      return `escribir «${preview}» en el campo «${plan.field}» de ${plan.app}`
  }
}

/** Aprobaciones que necesita la acción (y que «sí, no vuelvas a preguntar» guarda). */
function approvalsOf(plan: ActionPlan): LumiDesktopApproval[] {
  if (plan.kind === 'play_music') {
    return (['open_page', 'click_page'] as const).map((kind) => ({
      deviceId: plan.deviceId,
      kind,
      target: plan.target,
    }))
  }
  return [{ deviceId: plan.deviceId, kind: plan.kind, target: plan.target }]
}

async function isApproved(ctx: LumiToolContext, plan: ActionPlan): Promise<boolean> {
  for (const approval of approvalsOf(plan)) {
    if (!(await ctx.deps.desktop!.isApproved(ctx.userId, approval))) return false
  }
  return true
}

/**
 * Si el usuario ya aprobó este tipo de acción en este destino, se ejecuta; si no, se guarda como
 * pendiente y se pide confirmación.
 */
async function confirmOrRun(ctx: LumiToolContext, plan: ActionPlan): Promise<LumiToolResult> {
  const port = ctx.deps.desktop!
  if (await isApproved(ctx, plan)) return perform(ctx, plan)
  const summary = summarize(plan)
  const scope = `${KIND_PHRASE[plan.kind]} ${plan.kind.endsWith('_app') ? plan.app : plan.target}`
  const pending = await port.savePending(ctx.userId, { plan: JSON.stringify(plan) }, summary)
  return result(
    `Voy a ${summary} en «${plan.deviceName}». Responde «sí» para hacerlo, «sí, no vuelvas a preguntar» ` +
      `para no pedirte confirmación otra vez para ${scope} en este equipo, o «no» para cancelar.`,
    0,
    {
      confirmation: {
        id: pending.id,
        summary,
        device: plan.deviceName,
        scope,
        expiresAt: pending.expiresAt.toISOString(),
      },
    },
  )
}

/** Ejecuta una acción ya aprobada. Las de página y aplicación vuelven a localizar el elemento. */
async function perform(ctx: LumiToolContext, plan: ActionPlan): Promise<LumiToolResult> {
  const devices = await ctx.deps.desktop!.devices(ctx.userId)
  const device = devices.find((d) => d.id === plan.deviceId)
  if (!device || !device.online)
    return result(`«${plan.deviceName}» ya no está conectado; no hice nada.`, 0)
  if (device.paused)
    return result(`La ejecución está en pausa en «${plan.deviceName}»; no hice nada.`, 0)

  if (plan.kind === 'play_music') return playMusic(ctx, device, plan)

  if (plan.kind === 'open_page') {
    const outcome = await execute(ctx, device, 'browser.navigate', { url: plan.url })
    const title = clean(outcome.result?.title) ?? ''
    return result(
      actionText(
        outcome,
        `Abrí ${outcome.result?.url ?? plan.url}${title ? ` («${title}»)` : ''} en «${device.name}».`,
      ),
    )
  }

  if (plan.kind === 'click_page' || plan.kind === 'type_page') {
    const snap = await execute(ctx, device, 'browser.snapshot', { interactive: true })
    if (!ok(snap)) return result(failureText(snap), 0)
    // La aprobación era para este sitio: si el navegador está en otro, no se actúa.
    if (hostOf(snap.result?.url) !== plan.target) {
      return result(
        `La página de «${device.name}» ya no es de ${plan.target}; no hice nada. Vuelve a pedirlo.`,
        0,
      )
    }
    const wanted = plan.kind === 'click_page' ? plan.element! : plan.field!
    const found = resolveElement(
      pageElements(snap.result),
      wanted,
      plan.kind === 'click_page' ? 'click' : 'field',
    )
    if ('reply' in found) return result(found.reply, 0)
    if (plan.kind === 'click_page') {
      const outcome = await execute(ctx, device, 'browser.click', { ref: found.element.ref })
      return result(actionText(outcome, `Pulsé «${found.element.name}» en ${plan.target}.`))
    }
    const outcome = await execute(ctx, device, 'browser.fill', {
      ref: found.element.ref,
      value: plan.text,
    })
    return result(
      actionText(
        outcome,
        `Escribí el texto en «${found.element.name}» (${plan.text!.length} caracteres) y comprobé que quedó.`,
      ),
    )
  }

  const snap = await execute(ctx, device, 'desktop.snapshot', { app: plan.app })
  if (!ok(snap)) return result(failureText(snap), 0)
  const wanted = plan.kind === 'click_app' ? plan.element! : plan.field!
  const found = resolveElement(
    appElements(snap.result),
    wanted,
    plan.kind === 'click_app' ? 'click' : 'field',
  )
  if ('reply' in found) return result(found.reply, 0)
  if (plan.kind === 'click_app') {
    const outcome = await execute(ctx, device, 'desktop.click', { ref: found.element.ref })
    return result(actionText(outcome, `Pulsé «${found.element.name}» en ${plan.app}.`))
  }
  const outcome = await execute(ctx, device, 'desktop.set_value', {
    ref: found.element.ref,
    value: plan.text,
  })
  return result(
    actionText(
      outcome,
      `Escribí el texto en «${found.element.name}» de ${plan.app} (${plan.text!.length} caracteres) y comprobé que quedó.`,
    ),
  )
}

/**
 * Pone música en YouTube en el navegador del equipo: abre la búsqueda, lee la página, pulsa el vídeo
 * que coincide y comprueba que el navegador quedó en ese vídeo. Cada paso lo verifica el agente; el
 * texto final solo afirma lo comprobado (que el vídeo quedó abierto, no que se oiga).
 */
async function playMusic(
  ctx: LumiToolContext,
  device: LumiDesktopDevice,
  plan: ActionPlan,
): Promise<LumiToolResult> {
  const query = plan.query ?? ''
  const opened = await execute(ctx, device, 'browser.navigate', { url: youtubeSearchUrl(query) })
  if (!ok(opened)) return result(failureText(opened), 0)
  // La aprobación es para YouTube: si acabó en otra página (p. ej. el aviso de cookies), no se pulsa.
  if (hostOf(opened.result?.url) !== YOUTUBE_HOST) {
    return result(
      `Abrí YouTube en «${device.name}», pero quedó en otra página (${opened.result?.url ?? 'desconocida'}). Revísala en el equipo y vuelve a pedirlo.`,
      0,
    )
  }
  const snap = await execute(ctx, device, 'browser.snapshot', { interactive: true })
  if (!ok(snap)) return result(failureText(snap), 0)
  if (hostOf(snap.result?.url) !== YOUTUBE_HOST) {
    return result(`La página de «${device.name}» ya no es de YouTube; no pulsé nada.`, 0)
  }
  const video = pickVideoLink(pageElements(snap.result), query)
  if (!video) {
    return result(
      `Abrí la búsqueda de «${query}» en YouTube en «${device.name}», pero no encontré un vídeo que coincida para ponerlo. Elige uno en el equipo.`,
      0,
    )
  }
  const clicked = await execute(ctx, device, 'browser.click', { ref: video.ref })
  const name = clean(video.name, 90) ?? query
  const landed = String(clicked.result?.url ?? '')
  if (
    ok(clicked) &&
    hostOf(landed) === YOUTUBE_HOST &&
    /\/(?:watch|shorts)\b/.test(new URL(landed).pathname)
  ) {
    return result(
      `Puse «${name}» en YouTube en «${device.name}». YouTube debería empezar a reproducirlo; si el navegador lo bloquea, pulsa reproducir en el equipo.`,
    )
  }
  if (clicked.status === 'unverified' || ok(clicked)) {
    return result(
      `Pulsé «${name}» en YouTube en «${device.name}», pero no pude comprobar que se abriera el vídeo. Revísalo en el equipo.`,
    )
  }
  return result(failureText(clicked), 0)
}

/** Respuesta a «sí» / «sí, no vuelvas a preguntar» sobre una acción pendiente. */
export async function confirmDesktopAction(
  ctx: LumiToolContext,
  payload: Record<string, string>,
  remember: boolean,
): Promise<string> {
  if (!ctx.deps.desktop) return NO_PORT_TEXT
  let plan: ActionPlan
  try {
    plan = JSON.parse(payload.plan ?? '') as ActionPlan
  } catch {
    return 'No encontré la acción pendiente; vuelve a pedirla.'
  }
  const done = await perform(ctx, plan)
  if (!remember) return done.text
  for (const approval of approvalsOf(plan)) await ctx.deps.desktop.approve(ctx.userId, approval)
  const where = plan.kind.endsWith('_app') ? plan.app : plan.target
  return `${done.text}\nNo volveré a pedirte confirmación para ${KIND_PHRASE[plan.kind]} ${where} en «${plan.deviceName}». Puedes retirarlo en Lumia Admin → Dispositivos.`
}

/** «sí, no vuelvas a preguntar», «sí, no volver a mostrar», «sí, no preguntes más»… */
const REMEMBER =
  /\bno (?:me )?(?:vuelvas a (?:preguntar|mostrar)|volver a (?:preguntar|mostrar)|preguntes mas)\b/

/**
 * Respuesta a una acción del equipo que espera confirmación. null si el mensaje no es «sí»/«no» o
 * si no hay ninguna pendiente (el turno sigue su camino normal). La casilla «no volver a preguntar»
 * solo cuenta con «sí»: un «no» descarta la acción y la próxima vez se vuelve a preguntar.
 */
export async function handleDesktopReply(
  ctx: LumiToolContext,
  message: string,
  confirmationId?: string,
): Promise<string | null> {
  const port = ctx.deps.desktop
  if (!port) return null
  const normalized = normalizeText(message)
    .replace(/[.!¡]+$/g, '')
    .trim()
  const remember = REMEMBER.test(normalized)
  const confirmed =
    isConfirmation(normalized) || (remember && /^(?:si|confirmo|adelante|hazlo)\b/.test(normalized))
  const rejected = !confirmed && isRejection(normalized)
  if (!confirmed && !rejected) return null
  const payload = await port.takePending(ctx.userId, confirmationId)
  // Botón de una tarjeta que ya no está vigente (caducó, ya se respondió o hay otra más reciente).
  if (!payload && confirmationId) return 'Esa confirmación ya no está vigente; no hice nada.'
  if (!payload) return null
  return confirmed ? confirmDesktopAction(ctx, payload, remember) : rejectDesktopAction(payload)
}

export function rejectDesktopAction(payload: Record<string, string>): string {
  try {
    const plan = JSON.parse(payload.plan ?? '') as ActionPlan
    return `De acuerdo, no hice nada en «${plan.deviceName}».`
  } catch {
    return 'De acuerdo, no hice nada.'
  }
}

/* ───────────────────────── Herramientas ───────────────────────── */

const DEVICE_ARG: LumiSelectorArg = {
  name: 'equipo',
  kind: 'str',
  description: 'nombre del equipo si el usuario lo dice',
}

function deviceOf(args: Readonly<Record<string, unknown>>): string | undefined {
  return clean(args.equipo) ?? undefined
}

function build(
  input: DeviceInput,
  required: Array<keyof DeviceInput>,
): LumiSelectorBuild<DeviceInput> {
  const missing = required.filter((k) => !input[k])
  return missing.length ? { missing: missing as string[] } : { input }
}

interface DeviceToolSpec {
  name: LumiToolName
  label: string
  capability: string
  example: string
  description: string
  permission: PermissionId
  effect: 'read' | 'control'
  args: readonly LumiSelectorArg[]
  ask?: string
  fromArgs(args: Readonly<Record<string, unknown>>): LumiSelectorBuild<DeviceInput>
  match?(normalized: string, original: string): DeviceInput | null
  run(ctx: LumiToolContext, input: DeviceInput): Promise<LumiToolResult>
}

const URL_IN_TEXT =
  /(https?:\/\/[^\s«»"']+|www\.[^\s«»"']+|\b[a-z0-9-]+\.(?:com|co|net|org|io|dev|app|es|gov|edu)(?:\/[^\s«»"']*)?)/i
const OPEN_RULE =
  /^(?:por favor\s+)?(?:abre|abrir|ve a|entra a|entra en|navega a)\s+(?:la pagina\s+|el sitio\s+)?\S+/

/* Reglas (etapa 1) para órdenes claras del equipo. Los textos se toman del mensaje original. */

const PAGE_WORDS = /\s+(?:en|de)\s+(?:la\s+|esta\s+)?(?:pagina|p[aá]gina|web|navegador)\s*[.!?]?$/i
const CLICK_RULE =
  /^(?:por favor\s+)?(?:pulsa|presiona|oprime|haz clic en|da clic en|dale clic a|clic en)\s+(?:el\s+|la\s+)?(?:boton|bot[oó]n|enlace|link|opcion|opci[oó]n|casilla)?\s*["«]?(.+?)["»]?\s*[.!?]?$/i
const TYPE_RULE =
  /^(?:por favor\s+)?escrib[ea]\s+["«]?(.+?)["»]?\s+en\s+(?:el\s+)?campo\s+["«]?(.+?)["»]?\s*[.!?]?$/i
const READ_APP_RULE =
  /^(?:por favor\s+)?(?:lee|leer|mu[eé]strame)\s+(?:los\s+)?(?:botones|campos|elementos)\s+(?:de|del)\s+(?:la\s+|el\s+)?(.+?)\s*[.!?]?$/i
const APP_TAIL = /^(.+?)\s+(?:en|de|del)\s+(?:la\s+|el\s+)?(.+)$/i

/** «Pulsa X [en la página]» → página; «Pulsa X en la calculadora» → aplicación. */
function clickRule(original: string, target: 'page' | 'app'): DeviceInput | null {
  const text = original.trim()
  const onPage = PAGE_WORDS.test(text)
  const m = CLICK_RULE.exec(text.replace(PAGE_WORDS, ''))
  if (!m) return null
  const rest = clean(m[1]!)
  if (!rest) return null
  if (target === 'page') {
    // Sin «en <aplicación>» o con «en la página»: es la página.
    if (!onPage && APP_TAIL.test(rest)) return null
    return { element: rest }
  }
  if (onPage) return null
  const app = APP_TAIL.exec(rest)
  return app ? { element: clean(app[1]) ?? undefined, app: clean(app[2]) ?? undefined } : null
}

/** «Escribe T en el campo C [de la página | de <aplicación>]». */
function typeRule(original: string, target: 'page' | 'app'): DeviceInput | null {
  const text = original.trim()
  const onPage = PAGE_WORDS.test(text)
  const m = TYPE_RULE.exec(text.replace(PAGE_WORDS, ''))
  if (!m) return null
  const value = clean(m[1], TEXT_MAX)
  const fieldPart = clean(m[2])
  if (!value || !fieldPart) return null
  const app = APP_TAIL.exec(fieldPart)
  if (target === 'page') return onPage || !app ? { text: value, field: fieldPart } : null
  if (onPage || !app) return null
  return { text: value, field: clean(app[1]) ?? undefined, app: clean(app[2]) ?? undefined }
}

const SPECS: readonly DeviceToolSpec[] = [
  {
    name: 'device.status',
    label: 'Consultando tus equipos',
    capability: 'Ver mis equipos de escritorio y si están conectados',
    example: '¿Está conectado mi PC?',
    description:
      'Ver los equipos de escritorio del usuario, si están conectados y qué pueden hacer',
    permission: PERMISSION_REGISTRY.DESKTOP_DEVICES_READ,
    effect: 'read',
    args: [],
    fromArgs: () => ({ input: {} }),
    match: (n) =>
      /\b(?:mis equipos|estado de mi (?:pc|equipo|computador\w*)|(?:esta|estan) conectad[oa]s? mi[s]? (?:pc|equipos?|computador\w*))\b/.test(
        n,
      )
        ? {}
        : null,
    async run(ctx) {
      const port = ctx.deps.desktop
      if (!port) return result(NO_PORT_TEXT, 0)
      const devices = await port.devices(ctx.userId)
      if (devices.length === 0)
        return result('No tienes equipos inscritos. Inscribe uno en Lumia Admin → Dispositivos.', 0)
      const lines = devices.map((d) => {
        const state = !d.online ? 'desconectado' : d.paused ? 'conectado, en pausa' : 'conectado'
        const browser = d.operations.includes('browser.navigate') ? 'sí' : 'no'
        const apps = d.operations.includes('desktop.snapshot') ? 'sí' : 'no'
        return `• «${d.name}»: ${state} · navegador: ${browser} · aplicaciones: ${apps}`
      })
      return result(`Tus equipos:\n${lines.join('\n')}`, devices.length)
    },
  },
  {
    name: 'device.open_page',
    label: 'Abriendo la página en tu equipo',
    capability: 'Abrir una página web en el navegador de mi equipo',
    example: 'Abre lumiadalistore.com en mi PC',
    description: 'Abrir una página web (URL o dominio) en el navegador del equipo del usuario',
    permission: PERMISSION_REGISTRY.DESKTOP_BROWSER_CONTROL,
    effect: 'control',
    args: [
      {
        name: 'url',
        kind: 'str',
        required: true,
        description: 'dirección o dominio tal como lo dice el usuario',
      },
      DEVICE_ARG,
    ],
    ask: '¿Qué página abro? Dime la dirección, por ejemplo «example.com».',
    fromArgs: (a) =>
      build({ url: normalizeUrl(clean(a.url, 2048)) ?? undefined, device: deviceOf(a) }, ['url']),
    match(n, original) {
      if (!OPEN_RULE.test(n)) return null
      const url = normalizeUrl(URL_IN_TEXT.exec(original)?.[1] ?? null)
      return url ? { url } : null
    },
    async run(ctx, input) {
      const found = await resolveDevice(ctx, input.device, 'browser.navigate')
      if ('reply' in found) return result(found.reply, 0)
      const target = hostOf(input.url)
      if (!target) return result('Esa dirección no es válida.', 0)
      return confirmOrRun(ctx, {
        kind: 'open_page',
        deviceId: found.device.id,
        deviceName: found.device.name,
        target,
        url: input.url,
      })
    },
  },
  {
    name: 'device.play_music',
    label: 'Poniendo música en tu equipo',
    capability: 'Poner una canción o un artista en YouTube en el navegador de mi equipo',
    example: '/music Numb de Linkin Park',
    description:
      'Poner una canción o un artista en YouTube, en el navegador del equipo del usuario (con el reproductor oficial)',
    permission: PERMISSION_REGISTRY.DESKTOP_BROWSER_CONTROL,
    effect: 'control',
    args: [
      {
        name: 'cancion',
        kind: 'str',
        required: true,
        description: 'canción y/o artista tal como lo dice el usuario',
      },
      DEVICE_ARG,
    ],
    ask: '¿Qué canción o artista pongo?',
    fromArgs: (a) =>
      build({ query: clean(a.cancion, MUSIC_QUERY_MAX) ?? undefined, device: deviceOf(a) }, [
        'query',
      ]),
    // Comandos del chat de Lumia Admin: «/music X», «/play X», «/reproduce X».
    match(_n, original) {
      const m = MUSIC_COMMAND.exec(original.trim())
      const query = clean(m?.[1], MUSIC_QUERY_MAX)
      return query ? { query } : null
    },
    async run(ctx, input) {
      const found = await resolveDevice(ctx, input.device, 'browser.navigate')
      if ('reply' in found) return result(found.reply, 0)
      const missing = ['browser.snapshot', 'browser.click'].filter(
        (op) => !found.device.operations.includes(op),
      )
      if (missing.length) {
        return result(
          `«${found.device.name}» no puede leer ni pulsar páginas ahora mismo, así que no puedo poner la canción.`,
          0,
        )
      }
      return confirmOrRun(ctx, {
        kind: 'play_music',
        deviceId: found.device.id,
        deviceName: found.device.name,
        target: YOUTUBE_HOST,
        query: input.query,
      })
    },
  },
  {
    name: 'device.read_page',
    label: 'Leyendo la página de tu equipo',
    capability: 'Ver qué hay en la página abierta en mi equipo',
    example: '¿Qué hay en la página que tengo abierta?',
    description:
      'Leer la página abierta en el navegador del equipo: título, dirección y elementos que se pueden usar',
    permission: PERMISSION_REGISTRY.DESKTOP_BROWSER_READ,
    effect: 'read',
    args: [DEVICE_ARG],
    fromArgs: (a) => ({ input: { device: deviceOf(a) } }),
    match: (n) =>
      /\b(?:lee|leer|que hay en|que dice) (?:la|esta|esa) pagina\b/.test(n) ? {} : null,
    async run(ctx, input) {
      const found = await resolveDevice(ctx, input.device, 'browser.snapshot')
      if ('reply' in found) return result(found.reply, 0)
      const snap = await execute(ctx, found.device, 'browser.snapshot', { interactive: true })
      if (!ok(snap)) return result(failureText(snap), 0)
      const elements = pageElements(snap.result).filter((e) => e.name)
      const lines = elements
        .slice(0, LIST_MAX)
        .map((e) => `• ${ROLE_LABEL[e.role] ?? e.role} «${clean(e.name, 80)}»`)
      const more = elements.length > LIST_MAX ? `\n…y ${elements.length - LIST_MAX} más.` : ''
      return result(
        `Página en «${found.device.name}»: ${snap.result?.url ?? ''}\n` +
          (lines.length
            ? `Elementos que se pueden usar:\n${lines.join('\n')}${more}`
            : 'No hay elementos que se puedan usar.') +
          `\n(Contenido de la página: puede no ser fiable.)`,
        elements.length,
      )
    },
  },
  {
    name: 'device.click_page',
    label: 'Pulsando en la página de tu equipo',
    capability: 'Pulsar un botón o enlace de la página abierta en mi equipo',
    example: 'Pulsa el botón Enviar en la página',
    description:
      'Pulsar un botón, enlace o casilla de la página abierta en el navegador del equipo, por su nombre visible',
    permission: PERMISSION_REGISTRY.DESKTOP_BROWSER_CONTROL,
    effect: 'control',
    args: [
      {
        name: 'elemento',
        kind: 'str',
        required: true,
        description: 'nombre visible del botón o enlace',
      },
      DEVICE_ARG,
    ],
    ask: '¿Qué botón o enlace pulso? Dime su nombre tal como aparece.',
    fromArgs: (a) =>
      build({ element: clean(a.elemento) ?? undefined, device: deviceOf(a) }, ['element']),
    match: (_n, original) => clickRule(original, 'page'),
    async run(ctx, input) {
      return pageAction(ctx, input, 'click_page')
    },
  },
  {
    name: 'device.type_page',
    label: 'Escribiendo en la página de tu equipo',
    capability: 'Escribir un texto en un campo de la página abierta en mi equipo',
    example: 'Escribe Diego en el campo Nombre de la página',
    description: 'Escribir un texto en un campo de la página abierta en el navegador del equipo',
    permission: PERMISSION_REGISTRY.DESKTOP_BROWSER_CONTROL,
    effect: 'control',
    args: [
      { name: 'texto', kind: 'str', required: true, description: 'texto exacto a escribir' },
      { name: 'campo', kind: 'str', required: true, description: 'nombre visible del campo' },
      DEVICE_ARG,
    ],
    ask: '¿Qué texto escribo y en qué campo?',
    fromArgs: (a) =>
      build(
        {
          text: clean(a.texto, TEXT_MAX) ?? undefined,
          field: clean(a.campo) ?? undefined,
          device: deviceOf(a),
        },
        ['text', 'field'],
      ),
    match: (_n, original) => typeRule(original, 'page'),
    async run(ctx, input) {
      return pageAction(ctx, input, 'type_page')
    },
  },
  {
    name: 'device.windows',
    label: 'Viendo las aplicaciones de tu equipo',
    capability: 'Ver qué aplicaciones y ventanas tengo abiertas en mi equipo',
    example: '¿Qué aplicaciones tengo abiertas en mi PC?',
    description: 'Ver las aplicaciones y ventanas abiertas en el equipo del usuario',
    permission: PERMISSION_REGISTRY.DESKTOP_APPS_READ,
    effect: 'read',
    args: [DEVICE_ARG],
    fromArgs: (a) => ({ input: { device: deviceOf(a) } }),
    match: (n) =>
      /\bque (?:aplicaciones|ventanas|programas) (?:tengo |hay )?abiert/.test(n) ? {} : null,
    async run(ctx, input) {
      const found = await resolveDevice(ctx, input.device, 'desktop.list_windows')
      if ('reply' in found) return result(found.reply, 0)
      const out = await execute(ctx, found.device, 'desktop.list_windows', {})
      if (!ok(out)) return result(failureText(out), 0)
      const windows = (
        (out.result?.windows ?? []) as Array<{ app?: string; title?: string; blocked?: boolean }>
      ).slice(0, LIST_MAX)
      if (windows.length === 0)
        return result(`No hay ventanas abiertas en «${found.device.name}».`, 0)
      const lines = windows.map(
        (w) =>
          `• ${clean(w.title, 80) ?? '(sin título)'} — ${w.app ?? ''}${w.blocked ? ' (Lumia no la controla)' : ''}`,
      )
      return result(
        `Ventanas abiertas en «${found.device.name}»:\n${lines.join('\n')}`,
        windows.length,
      )
    },
  },
  {
    name: 'device.read_app',
    label: 'Leyendo una aplicación de tu equipo',
    capability: 'Ver los botones y campos de una aplicación abierta en mi equipo',
    example: '¿Qué botones tiene la calculadora?',
    description: 'Leer los elementos (botones, campos) de una aplicación abierta en el equipo',
    permission: PERMISSION_REGISTRY.DESKTOP_APPS_READ,
    effect: 'read',
    args: [
      {
        name: 'app',
        kind: 'str',
        required: true,
        description: 'nombre de la aplicación tal como lo dice el usuario',
      },
      DEVICE_ARG,
    ],
    ask: '¿Qué aplicación leo? Dime su nombre (por ejemplo, el de la lista de ventanas abiertas).',
    fromArgs: (a) => build({ app: clean(a.app) ?? undefined, device: deviceOf(a) }, ['app']),
    match(_n, original) {
      const m = READ_APP_RULE.exec(original.trim())
      const app = clean(m?.[1])
      return app ? { app } : null
    },
    async run(ctx, input) {
      const found = await resolveDevice(ctx, input.device, 'desktop.snapshot')
      if ('reply' in found) return result(found.reply, 0)
      const app = await resolveApp(ctx, found.device, input.app!)
      if ('reply' in app) return result(app.reply, 0)
      const snap = await execute(ctx, found.device, 'desktop.snapshot', { app: app.app })
      if (!ok(snap)) return result(failureText(snap), 0)
      const elements = appElements(snap.result)
      const lines = elements
        .slice(0, LIST_MAX)
        .map((e) => `• ${ROLE_LABEL[e.role] ?? e.role} «${clean(e.name, 80)}»`)
      const more = elements.length > LIST_MAX ? `\n…y ${elements.length - LIST_MAX} más.` : ''
      return result(
        `${app.app} en «${found.device.name}»:\n${lines.length ? lines.join('\n') + more : 'No tiene elementos que se puedan usar.'}` +
          `\n(Contenido de la aplicación: puede no ser fiable.)`,
        elements.length,
      )
    },
  },
  {
    name: 'device.click_app',
    label: 'Pulsando en una aplicación de tu equipo',
    capability: 'Pulsar un botón de una aplicación abierta en mi equipo',
    example: 'Pulsa Guardar en el Bloc de notas',
    description:
      'Pulsar un botón o elemento de una aplicación abierta en el equipo, por su nombre visible',
    permission: PERMISSION_REGISTRY.DESKTOP_APPS_CONTROL,
    effect: 'control',
    args: [
      { name: 'elemento', kind: 'str', required: true, description: 'nombre visible del botón' },
      { name: 'app', kind: 'str', required: true, description: 'nombre de la aplicación' },
      DEVICE_ARG,
    ],
    ask: '¿Qué botón pulso y en qué aplicación?',
    fromArgs: (a) =>
      build(
        {
          element: clean(a.elemento) ?? undefined,
          app: clean(a.app) ?? undefined,
          device: deviceOf(a),
        },
        ['element', 'app'],
      ),
    match: (_n, original) => clickRule(original, 'app'),
    async run(ctx, input) {
      return appAction(ctx, input, 'click_app')
    },
  },
  {
    name: 'device.type_app',
    label: 'Escribiendo en una aplicación de tu equipo',
    capability: 'Escribir un texto en un campo de una aplicación abierta en mi equipo',
    example: 'Escribe 125 en el campo Cantidad de la aplicación de inventario',
    description: 'Escribir un texto en un campo de una aplicación abierta en el equipo',
    permission: PERMISSION_REGISTRY.DESKTOP_APPS_CONTROL,
    effect: 'control',
    args: [
      { name: 'texto', kind: 'str', required: true, description: 'texto exacto a escribir' },
      { name: 'campo', kind: 'str', required: true, description: 'nombre visible del campo' },
      { name: 'app', kind: 'str', required: true, description: 'nombre de la aplicación' },
      DEVICE_ARG,
    ],
    ask: '¿Qué texto escribo, en qué campo y en qué aplicación?',
    fromArgs: (a) =>
      build(
        {
          text: clean(a.texto, TEXT_MAX) ?? undefined,
          field: clean(a.campo) ?? undefined,
          app: clean(a.app) ?? undefined,
          device: deviceOf(a),
        },
        ['text', 'field', 'app'],
      ),
    match: (_n, original) => typeRule(original, 'app'),
    async run(ctx, input) {
      return appAction(ctx, input, 'type_app')
    },
  },
]

async function pageAction(
  ctx: LumiToolContext,
  input: DeviceInput,
  kind: 'click_page' | 'type_page',
): Promise<LumiToolResult> {
  const operation = kind === 'click_page' ? 'browser.click' : 'browser.fill'
  const found = await resolveDevice(ctx, input.device, operation)
  if ('reply' in found) return result(found.reply, 0)
  // Se lee la página primero: la confirmación nombra el elemento real y el sitio real.
  const snap = await execute(ctx, found.device, 'browser.snapshot', { interactive: true })
  if (!ok(snap)) return result(failureText(snap), 0)
  const target = hostOf(snap.result?.url)
  if (!target) return result(`No hay una página web abierta en «${found.device.name}».`, 0)
  const wanted = kind === 'click_page' ? input.element! : input.field!
  const element = resolveElement(
    pageElements(snap.result),
    wanted,
    kind === 'click_page' ? 'click' : 'field',
  )
  if ('reply' in element) return result(element.reply, 0)
  return confirmOrRun(ctx, {
    kind,
    deviceId: found.device.id,
    deviceName: found.device.name,
    target,
    ...(kind === 'click_page'
      ? { element: element.element.name }
      : { field: element.element.name, text: input.text }),
  })
}

/**
 * Aplicación por el nombre que dice el usuario («calculadora») contra las ventanas abiertas: se
 * compara con el ejecutable y con el título. El agente vuelve a aplicar su política al actuar.
 */
async function resolveApp(
  ctx: LumiToolContext,
  device: LumiDesktopDevice,
  wanted: string,
): Promise<{ app: string } | { reply: string }> {
  const out = await execute(ctx, device, 'desktop.list_windows', {})
  if (!ok(out)) return { reply: failureText(out) }
  const windows = (out.result?.windows ?? []) as Array<{
    app?: string
    title?: string
    blocked?: boolean
  }>
  const target = plainText(wanted)
  const matches = windows.filter((w) => {
    const app = plainText((w.app ?? '').replace(/\.exe$/i, ''))
    const title = plainText(w.title ?? '')
    return app === target || app.includes(target) || title.includes(target)
  })
  const apps = [...new Set(matches.map((w) => w.app ?? ''))].filter(Boolean)
  if (apps.length === 1) {
    const match = matches.find((w) => w.app === apps[0])
    if (match?.blocked) return { reply: `No se pudo: ${ERROR_TEXT.APPLICATION_BLOCKED}.` }
    return { app: apps[0]! }
  }
  if (apps.length > 1)
    return {
      reply: `Hay varias aplicaciones que coinciden con «${wanted}»: ${apps.join(', ')}. ¿Cuál?`,
    }
  return { reply: `No encontré «${wanted}» entre las ventanas abiertas en «${device.name}».` }
}

async function appAction(
  ctx: LumiToolContext,
  input: DeviceInput,
  kind: 'click_app' | 'type_app',
): Promise<LumiToolResult> {
  const operation = kind === 'click_app' ? 'desktop.click' : 'desktop.set_value'
  const found = await resolveDevice(ctx, input.device, operation)
  if ('reply' in found) return result(found.reply, 0)
  const app = await resolveApp(ctx, found.device, input.app!)
  if ('reply' in app) return result(app.reply, 0)
  const snap = await execute(ctx, found.device, 'desktop.snapshot', { app: app.app })
  if (!ok(snap)) return result(failureText(snap), 0)
  const wanted = kind === 'click_app' ? input.element! : input.field!
  const element = resolveElement(
    appElements(snap.result),
    wanted,
    kind === 'click_app' ? 'click' : 'field',
  )
  if ('reply' in element) return result(element.reply, 0)
  return confirmOrRun(ctx, {
    kind,
    deviceId: found.device.id,
    deviceName: found.device.name,
    target: app.app.toLowerCase(),
    app: app.app,
    ...(kind === 'click_app'
      ? { element: element.element.name }
      : { field: element.element.name, text: input.text }),
  })
}

function deviceTool(spec: DeviceToolSpec): LumiTool<DeviceInput> {
  return {
    name: spec.name,
    capabilityKey: `tool-${spec.name.replace(/[._]/g, '-')}`,
    // Como la música: la limitan permisos propios que nadie tiene por defecto y DESKTOP_AGENT_ENABLED.
    // Se puede deshabilitar en Lumia Admin → Capacidades.
    enabledByDefault: true,
    label: spec.label,
    capability: spec.capability,
    example: spec.example,
    permission: spec.permission,
    external: { effect: spec.effect },
    match: (normalized, original) => spec.match?.(normalized, original) ?? null,
    selector: {
      description: spec.description,
      module: 'equipo',
      args: spec.args,
      ...(spec.ask ? { ask: spec.ask } : {}),
      fromArgs: spec.fromArgs,
    },
    run: (ctx, input) => spec.run(ctx, input),
  }
}

export const DEVICE_TOOLS: ReadonlyArray<LumiTool<DeviceInput>> = SPECS.map(deviceTool)

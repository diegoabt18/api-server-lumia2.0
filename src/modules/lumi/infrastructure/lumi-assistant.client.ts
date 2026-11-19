import { z } from 'zod'
import { AppError } from '../../../common/errors/app.error.js'
import { parseLumiReferences, type LumiReference } from '../references/lumi-references.js'
import type {
  LumiMusicArgs,
  LumiMusicCommandResult,
  LumiMusicDiscovery,
  LumiMusicReadResult,
  LumiMusicState,
  LumiMusicStateResult,
  LumiMusicTrack,
} from '../tools/tool.types.js'

/**
 * Cliente backend-to-backend hacia ia-asistente (Local AI Assistant).
 *
 * Solo el servidor habla con ia-asistente. Cada llamada lleva la clave de servicio y el
 * identificador del usuario autenticado en X-User-Ref; ia-asistente confía en ambos porque
 * solo este servidor conoce la clave. Los errores internos del asistente no se reenvían al cliente.
 */

export interface LumiAssistantClientOptions {
  baseUrl: string
  apiKey: string
  timeoutMs: number
  fetchImpl?: typeof fetch
}

const USER_REF_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const API_PREFIX = '/api/v1'

const chatUpstreamSchema = z.object({
  conversation_id: z.string(),
  model: z.string(),
  response: z.string(),
  /** Referencias guardadas con la respuesta (versiones anteriores de ia-asistente no la envían). */
  references: z.unknown().optional(),
})

const exchangeUpstreamSchema = z.object({ conversation_id: z.string() })

const usageUpstreamSchema = z.object({
  days: z.number(),
  requests: z.number(),
  prompt_tokens: z.number(),
  completion_tokens: z.number(),
})

const conversationSummaryUpstreamSchema = z.object({
  id: z.string(),
  title: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  message_count: z.number(),
})

const messageUpstreamSchema = z.object({
  id: z.number(),
  role: z.string(),
  content: z.string(),
  references: z.unknown().optional(),
  created_at: z.string(),
})

const conversationDetailUpstreamSchema = z.object({
  id: z.string(),
  title: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  messages: z.array(messageUpstreamSchema),
})

export interface LumiChatResult {
  conversationId: string
  model: string
  response: string
  references: LumiReference[]
}

export interface LumiUsage {
  days: number
  requests: number
  promptTokens: number
  completionTokens: number
}

export interface LumiConversationSummary {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  messageCount: number
}

export interface LumiConversationDetail {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  messages: Array<{ id: number; role: string; content: string; references: LumiReference[]; createdAt: string }>
}

/** Convierte un estado HTTP de ia-asistente en un error de la API de Lumi (sin detalles internos). */
function throwForStatus(res: Response): void {
  if (res.ok) return
  if (res.status === 404) throw AppError.notFound('Conversación no encontrada')
  if (res.status === 422) throw AppError.badRequest('El asistente rechazó la solicitud')
  if (res.status === 503) {
    throw new AppError(
      503,
      'El asistente Lumi no está disponible en este momento',
      'LUMI_UNAVAILABLE',
    )
  }
  throw new AppError(502, 'Error del asistente Lumi', 'LUMI_UPSTREAM_ERROR')
}

export type LumiStreamEvent =
  | { type: 'start'; conversationId: string }
  | { type: 'mode'; webSearch: boolean; reasoning: boolean }
  /** Herramienta del Server usada en el turno (consulta de datos reales, sin modelo). */
  | { type: 'tool'; name: string; label: string; rows: number; denied: boolean }
  | { type: 'thinking'; text: string }
  | { type: 'token'; text: string }
  /** Registros, módulos o fuentes web de la respuesta. Llega antes de `done` y solo si hay alguno. */
  | { type: 'references'; references: LumiReference[] }
  /** Estado real del reproductor tras un comando de música: el chat lo muestra como reproductor. */
  | { type: 'music'; state: LumiMusicState }
  | { type: 'done'; conversationId: string }
  | { type: 'error'; message: string }

const STREAM_ERROR_MESSAGE = 'El asistente Lumi no pudo completar la respuesta.'

const generateUpstreamSchema = z.object({ model: z.string(), text: z.string() })

/** Respuesta de /select. Se valida aquí: el Server no confía en la forma de lo que devuelve el asistente. */
const selectUpstreamSchema = z.object({
  status: z.enum(['tool', 'chat', 'missing', 'ambiguous']),
  intents: z.array(z.object({ tool: z.string().max(60), args: z.record(z.unknown()) })).max(2),
  need: z.string().max(200),
  module: z.string().max(40),
  errors: z.array(z.string()).max(10),
  model: z.string(),
  latency_ms: z.number(),
  prompt_tokens: z.number().int(),
  completion_tokens: z.number().int(),
})

/** Pista del asistente. La miniatura solo se acepta de YouTube (i.ytimg.com) y la URL, de youtube.com. */
const musicTrackUpstreamSchema = z.object({
  video_id: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
  title: z.string().min(1).max(300),
  artist: z.string().max(200).nullable().optional(),
  album: z.string().max(300).nullable().optional(),
  duration_seconds: z.number().int().nonnegative().nullable().optional(),
  thumbnail_url: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
})

const musicStateUpstreamSchema = z.object({
  status: z.enum(['idle', 'loading', 'playing', 'paused', 'stopped', 'error']),
  generation: z.number().int(),
  current: musicTrackUpstreamSchema.nullable(),
  upcoming: z.array(musicTrackUpstreamSchema).max(100),
  position_seconds: z.number().int().nonnegative(),
  duration_seconds: z.number().int().nonnegative().nullable().optional(),
  volume: z.number().int().min(0).max(100).optional(),
  output: z.object({ mode: z.enum(['aux', 'bluetooth']), sink: z.string().nullable() }),
  error: z.string().max(500).nullable(),
  // Opcionales: un asistente anterior no los envía (se toman los valores por defecto).
  shuffle: z.boolean().optional(),
  repeat_mode: z.enum(['off', 'one', 'all']).optional(),
  autoplay: z.boolean().optional(),
  version: z.number().int().nonnegative().optional(),
  updated_at: z.number().int().nonnegative().optional(),
})

const musicTracksUpstreamSchema = z.object({ tracks: z.array(musicTrackUpstreamSchema).max(100) })

const musicDiscoveryUpstreamSchema = z.object({
  seed: musicTrackUpstreamSchema.nullable(),
  tracks: z.array(musicTrackUpstreamSchema).max(50),
  artist_tracks: z.array(musicTrackUpstreamSchema).max(50),
  artists: z.array(z.object({ name: z.string().min(1).max(200), tracks: z.number().int().nonnegative() })).max(20),
})

/** Referencia fija con la que el Server abre el canal de eventos del reproductor (compartido). */
export const LUMI_MUSIC_HUB_USER_REF = 'lumia-music-hub'

/** Respuesta de POST /music/commands: texto determinista y estado del reproductor. */
const musicCommandUpstreamSchema = z.object({
  ok: z.boolean(),
  text: z.string().min(1).max(4000),
  error: z.string().nullable().optional(),
  // Se valida aparte (toMusicState): un estado con forma inesperada no impide mostrar el texto.
  state: z.unknown().optional(),
})

const THUMBNAIL_RE = /^https:\/\/i\.ytimg\.com\/vi\/[A-Za-z0-9_-]{11}\/[a-z0-9_]+\.(?:jpg|webp)$/
const WATCH_RE = /^https:\/\/www\.youtube\.com\/watch\?v=[A-Za-z0-9_-]{11}$/

function toMusicTrack(raw: z.infer<typeof musicTrackUpstreamSchema>): LumiMusicTrack {
  return {
    videoId: raw.video_id,
    title: raw.title,
    artist: raw.artist ?? null,
    album: raw.album ?? null,
    durationSeconds: raw.duration_seconds ?? null,
    // Lo que no tiene la forma esperada no llega al navegador.
    thumbnailUrl: raw.thumbnail_url && THUMBNAIL_RE.test(raw.thumbnail_url) ? raw.thumbnail_url : null,
    url: raw.url && WATCH_RE.test(raw.url) ? raw.url : null,
    source: 'youtube',
  }
}

/** Convierte el estado del asistente al del Server (sin el nombre del dispositivo de audio del host). */
export function toMusicState(raw: unknown): LumiMusicState {
  const parsed = musicStateUpstreamSchema.parse(raw)
  return {
    status: parsed.status,
    generation: parsed.generation,
    current: parsed.current ? toMusicTrack(parsed.current) : null,
    upcoming: parsed.upcoming.map(toMusicTrack),
    positionSeconds: parsed.position_seconds,
    durationSeconds: parsed.duration_seconds ?? parsed.current?.duration_seconds ?? null,
    volume: parsed.volume ?? 0,
    output: { mode: parsed.output.mode, active: Boolean(parsed.output.sink) },
    error: parsed.error,
    shuffle: parsed.shuffle ?? false,
    repeatMode: parsed.repeat_mode ?? 'off',
    autoplay: parsed.autoplay ?? false,
    version: parsed.version ?? 0,
    updatedAt: parsed.updated_at ?? null,
  }
}

/** Tiempo límite de recomendaciones y búsquedas (consultan YouTube). */
export const LUMI_MUSIC_DISCOVER_TIMEOUT_MS = 25_000

/** Tiempo límite de un comando de música (buscar y esperar a que suene puede tardar unos segundos). */
export const LUMI_MUSIC_COMMAND_TIMEOUT_MS = 30_000
/** Tiempo límite de la consulta del estado (el reproductor lo consulta a menudo: debe ser rápida). */
export const LUMI_MUSIC_STATE_TIMEOUT_MS = 5_000

export interface LumiSelectRequest {
  message: string
  context?: string
  tools: Array<{ name: string; description: string; args: Array<{ name: string; kind: string | string[]; required: boolean; description: string }> }>
  modules: string[]
  examples?: Array<{ message: string; tool: string; args: Record<string, unknown> }>
}

export interface LumiSelectResult {
  status: 'tool' | 'chat' | 'missing' | 'ambiguous'
  intents: Array<{ tool: string; args: Record<string, unknown> }>
  need: string
  module: string
  errors: string[]
  model: string
  latencyMs: number
  promptTokens: number
  completionTokens: number
}

const streamStartSchema = z.object({ conversation_id: z.string() })
const streamTokenSchema = z.object({ text: z.string() })
const streamThinkingSchema = z.object({ text: z.string() })
const streamDoneSchema = z.object({ conversation_id: z.string() })

/**
 * Referencias que ia-asistente guardó con la respuesta (fuentes web o las que envió el Server) y
 * devuelve en su evento `done`. Si `references` falta (versión anterior), se usan sus `sources`.
 */
export function doneReferences(rawData: string): LumiReference[] {
  let json: unknown
  try {
    json = JSON.parse(rawData)
  } catch {
    return []
  }
  if (typeof json !== 'object' || json === null) return []
  const data = json as { references?: unknown; sources?: unknown }
  if (data.references !== undefined) return parseLumiReferences(data.references)
  if (!Array.isArray(data.sources)) return []
  return parseLumiReferences(
    data.sources.map((s) => (typeof s === 'object' && s !== null ? { type: 'web_source', ...s } : s)),
  )
}

/** Separa bloques SSE completos (terminados en línea vacía). Lo incompleto queda en `rest`. */
export function splitSseBuffer(buffer: string): { blocks: string[]; rest: string } {
  const parts = buffer.split('\n\n')
  const rest = parts.pop() ?? ''
  return { blocks: parts, rest }
}

/** Lee un bloque SSE: nombre del evento y datos (varias líneas `data:` se unen con salto de línea). */
export function parseSseBlock(block: string): { event: string; data: string } | null {
  let event = 'message'
  const data: string[] = []
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) continue
    const sep = line.indexOf(':')
    if (sep < 0) continue
    const field = line.slice(0, sep)
    const value = line.slice(sep + 1).replace(/^ /, '')
    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
  }
  if (data.length === 0) return null
  return { event, data: data.join('\n') }
}

/**
 * Traduce un evento de ia-asistente al contrato de Lumi. Solo pasan los eventos conocidos y con
 * la forma esperada; los demás (fuentes, verificación) no se usan en el chat del admin.
 */
export function toLumiStreamEvent(event: string, rawData: string): LumiStreamEvent | null {
  let json: unknown
  try {
    json = JSON.parse(rawData)
  } catch {
    return null
  }
  if (event === 'start') {
    const parsed = streamStartSchema.safeParse(json)
    return parsed.success ? { type: 'start', conversationId: parsed.data.conversation_id } : null
  }
  if (event === 'token') {
    const parsed = streamTokenSchema.safeParse(json)
    return parsed.success ? { type: 'token', text: parsed.data.text } : null
  }
  if (event === 'thinking') {
    const parsed = streamThinkingSchema.safeParse(json)
    return parsed.success ? { type: 'thinking', text: parsed.data.text } : null
  }
  if (event === 'done') {
    const parsed = streamDoneSchema.safeParse(json)
    return parsed.success ? { type: 'done', conversationId: parsed.data.conversation_id } : null
  }
  if (event === 'error') return { type: 'error', message: STREAM_ERROR_MESSAGE }
  return null
}

/** Opciones por turno que el administrador elige en el chat. */
export interface LumiTurnOptions {
  think?: boolean
  maxTokens?: number
  /** Qué puede hacer el sistema por este usuario (lo escribe el Server según sus permisos). */
  capabilities?: string
  /** Referencias de los datos que la herramienta leyó para este turno: se guardan con la respuesta. */
  references?: LumiReference[]
}

/** Límite del texto de capacidades (el asistente acepta hasta 2000 caracteres). */
export const LUMI_CAPABILITIES_MAX_CHARS = 2000

/** Solo envía lo que se pidió: sin opciones, el cuerpo es el de siempre. */
function turnOptionsBody(options: LumiTurnOptions): {
  think?: true
  max_tokens?: number
  capabilities?: string
  references?: LumiReference[]
} {
  return {
    ...(options.think ? { think: true as const } : {}),
    ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
    ...(options.capabilities ? { capabilities: options.capabilities.slice(0, LUMI_CAPABILITIES_MAX_CHARS) } : {}),
    ...(options.references?.length ? { references: options.references } : {}),
  }
}

export class LumiAssistantClient {
  private readonly fetchImpl: typeof fetch

  constructor(private readonly options: LumiAssistantClientOptions) {
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))
  }

  async chat(
    userRef: string,
    message: string,
    conversationId?: string,
    context?: string,
    useWeb = false,
    options: LumiTurnOptions = {},
  ): Promise<LumiChatResult> {
    const body = await this.request(userRef, 'POST', '/chat', {
      message,
      conversation_id: conversationId ?? null,
      // Solo true en modo búsqueda web (lumi.web). En ese modo no se envía contexto.
      use_web: useWeb,
      ...(context && !useWeb ? { context } : {}),
      ...turnOptionsBody(options),
    })
    const parsed = chatUpstreamSchema.parse(body)
    return {
      conversationId: parsed.conversation_id,
      model: parsed.model,
      response: parsed.response,
      references: parseLumiReferences(parsed.references),
    }
  }

  /**
   * Guarda un turno que el backend resolvió sin modelo (p. ej. pedidos recientes), con las
   * referencias de sus datos para que el historial las conserve.
   */
  async recordExchange(
    userRef: string,
    message: string,
    answer: string,
    conversationId?: string,
    references: LumiReference[] = [],
  ): Promise<{ conversationId: string }> {
    const body = await this.request(userRef, 'POST', '/chat/exchange', {
      message,
      answer,
      conversation_id: conversationId ?? null,
      ...(references.length ? { references } : {}),
    })
    const parsed = exchangeUpstreamSchema.parse(body)
    return { conversationId: parsed.conversation_id }
  }

  async listConversations(
    userRef: string,
    limit: number,
    offset: number,
  ): Promise<LumiConversationSummary[]> {
    const body = await this.request(
      userRef,
      'GET',
      `/conversations?limit=${limit}&offset=${offset}`,
    )
    return z
      .array(conversationSummaryUpstreamSchema)
      .parse(body)
      .map((c) => ({
        id: c.id,
        title: c.title,
        createdAt: c.created_at,
        updatedAt: c.updated_at,
        messageCount: c.message_count,
      }))
  }

  async getConversation(userRef: string, conversationId: string): Promise<LumiConversationDetail> {
    const body = await this.request(
      userRef,
      'GET',
      `/conversations/${encodeURIComponent(conversationId)}`,
    )
    const c = conversationDetailUpstreamSchema.parse(body)
    return {
      id: c.id,
      title: c.title,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
      messages: c.messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        // Mensajes antiguos: sin referencias. Las inválidas se descartan una a una.
        references: parseLumiReferences(m.references),
        createdAt: m.created_at,
      })),
    }
  }

  async deleteConversation(userRef: string, conversationId: string): Promise<void> {
    await this.request(userRef, 'DELETE', `/conversations/${encodeURIComponent(conversationId)}`)
  }

  async usage(userRef: string, days: number): Promise<LumiUsage> {
    const body = await this.request(userRef, 'GET', `/usage?days=${days}`)
    const u = usageUpstreamSchema.parse(body)
    return {
      days: u.days,
      requests: u.requests,
      promptTokens: u.prompt_tokens,
      completionTokens: u.completion_tokens,
    }
  }

  /**
   * Respuesta en streaming. Los errores previos al primer evento (conversación inexistente,
   * servicio caído) se lanzan al llamar; después, el stream se cierra al abortar `signal`.
   */
  /**
   * Etapa 2 de Lumi: el modelo propone herramienta, conversación o capacidad que falta. No crea
   * conversación. Tiene su propio tiempo límite: si se agota, el turno sigue como conversación.
   */
  async select(userRef: string, payload: LumiSelectRequest, timeoutMs: number): Promise<LumiSelectResult> {
    const body = await this.request(
      userRef,
      'POST',
      '/select',
      {
        message: payload.message,
        context: payload.context ?? null,
        tools: payload.tools,
        modules: payload.modules,
        examples: payload.examples ?? [],
      },
      timeoutMs,
    )
    const parsed = selectUpstreamSchema.parse(body)
    return {
      status: parsed.status,
      intents: parsed.intents,
      need: parsed.need,
      module: parsed.module,
      errors: parsed.errors,
      model: parsed.model,
      latencyMs: parsed.latency_ms,
      promptTokens: parsed.prompt_tokens,
      completionTokens: parsed.completion_tokens,
    }
  }

  /**
   * Comando del módulo de música (`{tool, args}`). Nunca lanza: devuelve el texto determinista del
   * asistente, o por qué no se pudo (módulo apagado = 404, asistente caído, respuesta inesperada).
   */
  async musicCommand(
    userRef: string,
    tool: string,
    args: LumiMusicArgs,
    timeoutMs: number = Math.min(this.options.timeoutMs, LUMI_MUSIC_COMMAND_TIMEOUT_MS),
  ): Promise<LumiMusicCommandResult> {
    if (!USER_REF_PATTERN.test(userRef)) return { status: 'rejected' }
    const res = await this.musicFetch(userRef, 'POST', '/music/commands', { tool, args }, timeoutMs)
    if (res === null) return { status: 'unavailable' }
    if (res.status === 404) return { status: 'disabled' }
    if (res.status === 422) return { status: 'rejected' }
    if (!res.ok) return { status: 'unavailable' }
    try {
      const parsed = musicCommandUpstreamSchema.parse(await res.json())
      let state: LumiMusicState | null = null
      try {
        state = parsed.state ? toMusicState(parsed.state) : null
      } catch {
        state = null // un estado con forma inesperada no impide mostrar el texto
      }
      return { status: 'done', ok: parsed.ok, text: parsed.text, error: parsed.error ?? null, state }
    } catch {
      return { status: 'unavailable' }
    }
  }

  /** Estado del reproductor (GET /music/state). Nunca lanza. */
  async musicState(
    userRef: string,
    timeoutMs: number = Math.min(this.options.timeoutMs, LUMI_MUSIC_STATE_TIMEOUT_MS),
  ): Promise<LumiMusicStateResult> {
    if (!USER_REF_PATTERN.test(userRef)) return { status: 'unavailable' }
    const res = await this.musicFetch(userRef, 'GET', '/music/state', undefined, timeoutMs)
    if (res === null) return { status: 'unavailable' }
    if (res.status === 404) return { status: 'disabled' }
    if (!res.ok) return { status: 'unavailable' }
    try {
      return { status: 'done', state: toMusicState(await res.json()) }
    } catch {
      return { status: 'unavailable' }
    }
  }

  /** Recomendaciones reales para una canción (la actual si no se indica). Nunca lanza. */
  async musicRecommendations(userRef: string, videoId: string | null): Promise<LumiMusicReadResult<LumiMusicDiscovery>> {
    const query = videoId ? `?video_id=${encodeURIComponent(videoId)}` : ''
    return this.musicRead(userRef, `/music/recommendations${query}`, (raw) => {
      const parsed = musicDiscoveryUpstreamSchema.parse(raw)
      return {
        seed: parsed.seed ? toMusicTrack(parsed.seed) : null,
        tracks: parsed.tracks.map(toMusicTrack),
        artistTracks: parsed.artist_tracks.map(toMusicTrack),
        artists: parsed.artists,
      }
    })
  }

  /** Últimas canciones que sonaron (la más reciente primero). Nunca lanza. */
  async musicHistory(userRef: string): Promise<LumiMusicReadResult<LumiMusicTrack[]>> {
    return this.musicRead(userRef, '/music/history', (raw) => musicTracksUpstreamSchema.parse(raw).tracks.map(toMusicTrack))
  }

  /** Búsqueda en YouTube sin reproducir. Nunca lanza. */
  async musicSearch(userRef: string, query: string, limit: number): Promise<LumiMusicReadResult<LumiMusicTrack[]>> {
    const params = new URLSearchParams({ q: query, limit: String(limit) })
    return this.musicRead(userRef, `/music/search?${params.toString()}`, (raw) =>
      musicTracksUpstreamSchema.parse(raw).tracks.map(toMusicTrack),
    )
  }

  /**
   * Canal SSE de estado del reproductor (GET /music/events). Lo abre el hub del Server con una
   * referencia fija: el estado es el mismo para todos los usuarios con music.read.
   */
  async musicEvents(signal: AbortSignal): Promise<Response | null> {
    try {
      return await this.fetchImpl(`${this.options.baseUrl}${API_PREFIX}/music/events`, {
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          'X-API-Key': this.options.apiKey,
          'X-User-Ref': LUMI_MUSIC_HUB_USER_REF,
        },
        signal,
      })
    } catch {
      return null
    }
  }

  private async musicRead<T>(userRef: string, path: string, parse: (raw: unknown) => T): Promise<LumiMusicReadResult<T>> {
    if (!USER_REF_PATTERN.test(userRef)) return { status: 'unavailable' }
    const res = await this.musicFetch(userRef, 'GET', path, undefined, LUMI_MUSIC_DISCOVER_TIMEOUT_MS)
    if (res === null) return { status: 'unavailable' }
    if (res.status === 404) return { status: 'disabled' }
    if (!res.ok) return { status: 'unavailable' }
    try {
      return { status: 'done', data: parse(await res.json()) }
    } catch {
      return { status: 'unavailable' }
    }
  }

  private async musicFetch(
    userRef: string,
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<Response | null> {
    try {
      return await this.fetchImpl(`${this.options.baseUrl}${API_PREFIX}${path}`, {
        method,
        headers: {
          Accept: 'application/json',
          'X-API-Key': this.options.apiKey,
          'X-User-Ref': userRef,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch {
      return null
    }
  }

  /** Genera texto con instrucciones fijas. No crea conversación ni guarda historial. */
  async generate(
    userRef: string,
    instructions: string,
    text: string,
    maxTokens: number,
    temperature = 0.4,
  ): Promise<{ model: string; text: string }> {
    const body = await this.request(userRef, 'POST', '/generate', {
      instructions,
      text,
      temperature,
      max_tokens: maxTokens,
    })
    return generateUpstreamSchema.parse(body)
  }

  async *chatStream(
    userRef: string,
    message: string,
    conversationId: string | undefined,
    signal: AbortSignal,
    context?: string,
    useWeb = false,
    options: LumiTurnOptions = {},
  ): AsyncGenerator<LumiStreamEvent> {
    if (!USER_REF_PATTERN.test(userRef)) {
      throw AppError.badRequest('Identificador de usuario no válido para el asistente')
    }
    const res = await this.fetchStream(
      userRef,
      {
        message,
        conversation_id: conversationId ?? null,
        use_web: useWeb,
        ...(context && !useWeb ? { context } : {}),
        ...turnOptionsBody(options),
      },
      signal,
    )
    throwForStatus(res)
    if (!res.body) throw new AppError(502, 'Error del asistente Lumi', 'LUMI_UPSTREAM_ERROR')

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const { blocks, rest } = splitSseBuffer(buffer)
        buffer = rest
        for (const block of blocks) {
          const parsed = parseSseBlock(block)
          if (!parsed) continue
          const event = toLumiStreamEvent(parsed.event, parsed.data)
          if (!event) continue
          if (event.type === 'done') {
            // Las referencias van antes del cierre: el chat las asocia al mensaje que termina.
            const references = doneReferences(parsed.data)
            if (references.length) yield { type: 'references', references }
          }
          yield event
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined)
    }
  }

  /** Abre la conexión. El tiempo máximo cubre toda la respuesta (LUMI_ASSISTANT_TIMEOUT_MS). */
  private async fetchStream(
    userRef: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<Response> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs)
    try {
      return await this.fetchImpl(`${this.options.baseUrl}${API_PREFIX}/chat/stream`, {
        method: 'POST',
        headers: {
          Accept: 'text/event-stream',
          'Content-Type': 'application/json',
          'X-API-Key': this.options.apiKey,
          'X-User-Ref': userRef,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.any([signal, timeout]),
      })
    } catch {
      throw new AppError(
        503,
        'El asistente Lumi no está disponible en este momento',
        'LUMI_UNAVAILABLE',
      )
    }
  }

  private async request(
    userRef: string,
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
    timeoutMs: number = this.options.timeoutMs,
  ): Promise<unknown> {
    if (!USER_REF_PATTERN.test(userRef)) {
      throw AppError.badRequest('Identificador de usuario no válido para el asistente')
    }

    let res: Response
    try {
      res = await this.fetchImpl(`${this.options.baseUrl}${API_PREFIX}${path}`, {
        method,
        headers: {
          Accept: 'application/json',
          'X-API-Key': this.options.apiKey,
          'X-User-Ref': userRef,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch {
      throw new AppError(
        503,
        'El asistente Lumi no está disponible en este momento',
        'LUMI_UNAVAILABLE',
      )
    }

    throwForStatus(res)
    if (res.status === 204) return undefined

    try {
      return await res.json()
    } catch {
      throw new AppError(502, 'Respuesta inválida del asistente Lumi', 'LUMI_UPSTREAM_ERROR')
    }
  }
}

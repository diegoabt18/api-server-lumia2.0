import type { LumiMusicState } from '../tools/tool.types.js'
import { parseSseBlock, splitSseBuffer, toMusicState } from './lumi-assistant.client.js'

/** Lo que reciben los navegadores suscritos: el estado real o por qué no hay reproductor. */
export type LumiMusicHubEvent =
  | { type: 'state'; state: LumiMusicState }
  | { type: 'unavailable'; reason: 'disabled' | 'unavailable' }

export interface LumiMusicEventSource {
  /** Abre GET /music/events del asistente. null si no responde. */
  musicEvents(signal: AbortSignal): Promise<Response | null>
}

type Listener = (event: LumiMusicHubEvent) => void
type Log = { warn: (obj: object, msg: string) => void; info?: (obj: object, msg: string) => void }

/** Esperas entre reintentos de la conexión con el asistente (la última se repite). */
export const MUSIC_HUB_RETRY_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const

/**
 * Reparte el estado del reproductor a todos los navegadores con UNA sola conexión al asistente.
 *
 * Hay un único reproductor (una salida de audio en el servidor del asistente): su estado es el mismo
 * para todos, así que no hace falta una conexión por pestaña. La conexión se abre con el primer
 * suscriptor y se cierra con el último; si se corta, se reintenta con esperas crecientes mientras
 * quede alguien escuchando. Cada suscriptor nuevo recibe al momento el último estado conocido.
 */
export class LumiMusicHub {
  private readonly listeners = new Set<Listener>()
  private upstream: AbortController | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private attempt = 0
  private last: LumiMusicHubEvent | null = null

  constructor(
    private readonly source: LumiMusicEventSource,
    private readonly log?: Log,
    private readonly retryDelays: readonly number[] = MUSIC_HUB_RETRY_MS,
  ) {}

  /** Navegadores suscritos ahora mismo. */
  get subscribers(): number {
    return this.listeners.size
  }

  /** true mientras hay una conexión abierta (o abriéndose) con el asistente. */
  get connected(): boolean {
    return this.upstream !== null
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    if (this.last) listener(this.last)
    if (!this.upstream && !this.retryTimer) void this.connect()
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) this.stop()
    }
  }

  private stop(): void {
    this.upstream?.abort()
    this.upstream = null
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.attempt = 0
    this.last = null
  }

  private emit(event: LumiMusicHubEvent): void {
    // «Sin reproductor» repetido no se reenvía en cada reintento.
    if (event.type === 'unavailable' && this.last?.type === 'unavailable' && this.last.reason === event.reason) return
    this.last = event
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch (error) {
        this.log?.warn({ err: error }, 'Lumi music listener failed')
      }
    }
  }

  private async connect(): Promise<void> {
    const controller = new AbortController()
    this.upstream = controller
    const res = await this.source.musicEvents(controller.signal)
    if (controller.signal.aborted) return
    if (!res || !res.ok || !res.body) {
      this.emit({ type: 'unavailable', reason: res?.status === 404 ? 'disabled' : 'unavailable' })
      this.retry(controller)
      return
    }
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
          if (!parsed || parsed.event !== 'state') continue
          try {
            this.emit({ type: 'state', state: toMusicState(JSON.parse(parsed.data)) })
            this.attempt = 0
          } catch {
            // Un estado con forma inesperada se ignora: el siguiente lo corrige.
          }
        }
      }
    } catch {
      // Conexión cortada (o cerrada por stop): se decide abajo.
    } finally {
      await reader.cancel().catch(() => undefined)
    }
    if (controller.signal.aborted) return
    this.log?.info?.({ attempt: this.attempt }, 'Lumi music events closed; retrying')
    this.emit({ type: 'unavailable', reason: 'unavailable' })
    this.retry(controller)
  }

  private retry(controller: AbortController): void {
    if (this.upstream === controller) this.upstream = null
    if (this.listeners.size === 0) return
    const delay = this.retryDelays[Math.min(this.attempt, this.retryDelays.length - 1)] ?? 30_000
    this.attempt += 1
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (this.listeners.size > 0 && !this.upstream) void this.connect()
    }, delay)
    this.retryTimer.unref?.()
  }
}

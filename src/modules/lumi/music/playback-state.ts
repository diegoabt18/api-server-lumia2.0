import type { TaskStage } from '../desktop-agent/domain/protocol.js'

/**
 * Estados de una reproducción de música en el equipo. Solo avanzan hacia delante; un error termina
 * la reproducción. COMPLETED exige reproducción confirmada **y** ventana minimizada; si la ventana no
 * se minimizó la reproducción termina en MINIMIZE_FAILED (resultado parcial: suena igualmente).
 */
export const MUSIC_PLAYBACK_STATES = [
  'RECEIVED',
  'VALIDATED',
  'BROWSER_READY',
  'TAB_READY',
  'NAVIGATING',
  'NAVIGATION_COMPLETED',
  'PLAYING',
  'MINIMIZING',
  'COMPLETED',
] as const

export const MUSIC_PLAYBACK_ERRORS = [
  'BROWSER_UNAVAILABLE',
  'TAB_UNAVAILABLE',
  'NAVIGATION_FAILED',
  'VIDEO_UNAVAILABLE',
  'PLAYBACK_BLOCKED',
  'PLAYBACK_FAILED',
  'MINIMIZE_FAILED',
  'EXECUTION_TIMEOUT',
] as const

export type MusicPlaybackState =
  | (typeof MUSIC_PLAYBACK_STATES)[number]
  | (typeof MUSIC_PLAYBACK_ERRORS)[number]

const ORDER: readonly MusicPlaybackState[] = MUSIC_PLAYBACK_STATES

/** Paso del agente → estado. `tab.reused` y `tab.created` son ambos TAB_READY. */
export const STAGE_STATE: Record<TaskStage, MusicPlaybackState> = {
  'browser.ready': 'BROWSER_READY',
  'tab.reused': 'TAB_READY',
  'tab.created': 'TAB_READY',
  'navigation.started': 'NAVIGATING',
  'navigation.completed': 'NAVIGATION_COMPLETED',
  'playback.started': 'PLAYING',
  'browser.minimizing': 'MINIMIZING',
  // La minimización solo cuenta al llegar el resultado final, que confirma COMPLETED.
  'browser.minimized': 'MINIMIZING',
  'browser.minimize_failed': 'MINIMIZE_FAILED',
}

/** Código de error del agente o del Server → estado de error. */
export function errorState(code: string | null | undefined): MusicPlaybackState {
  switch (code) {
    case 'TAB_UNAVAILABLE':
      return 'TAB_UNAVAILABLE'
    case 'NAVIGATION_FAILED':
      return 'NAVIGATION_FAILED'
    case 'VIDEO_UNAVAILABLE':
      return 'VIDEO_UNAVAILABLE'
    case 'PLAYBACK_BLOCKED':
      return 'PLAYBACK_BLOCKED'
    case 'PLAYBACK_FAILED':
    case 'VERIFICATION_FAILED':
      return 'PLAYBACK_FAILED'
    case 'OPERATION_TIMEOUT':
    case 'NO_RESULT':
    case 'DELIVERY_EXPIRED':
      return 'EXECUTION_TIMEOUT'
    default:
      // Navegador o motor ausentes, equipo desconectado o en pausa: no hay navegador disponible.
      return 'BROWSER_UNAVAILABLE'
  }
}

export function isErrorState(state: MusicPlaybackState): boolean {
  return (MUSIC_PLAYBACK_ERRORS as readonly string[]).includes(state)
}

/** Estado terminal (éxito o error): ya no admite transiciones. */
export function isFinalState(state: MusicPlaybackState): boolean {
  return state === 'COMPLETED' || isErrorState(state)
}

/**
 * Máquina de estados de una reproducción. `advance` devuelve false (y no cambia nada) ante una
 * transición inválida: hacia atrás, repetida, tras un estado final o COMPLETED sin pasar por
 * PLAYING y MINIMIZING. PLAYING puede terminar sin minimizar (`minimize: false`).
 */
export class MusicPlaybackMachine {
  private current: MusicPlaybackState = 'RECEIVED'

  get state(): MusicPlaybackState {
    return this.current
  }

  advance(next: MusicPlaybackState): boolean {
    if (isFinalState(this.current) || next === this.current) return false
    if (isErrorState(next)) {
      // MINIMIZE_FAILED solo es posible con la reproducción ya confirmada.
      if (next === 'MINIMIZE_FAILED') {
        if (this.current !== 'PLAYING' && this.current !== 'MINIMIZING') return false
      }
      this.current = next
      return true
    }
    const from = ORDER.indexOf(this.current)
    const to = ORDER.indexOf(next)
    if (to <= from) return false
    if (next === 'COMPLETED' && this.current !== 'MINIMIZING') return false
    // Los pasos del navegador no pueden saltarse la confirmación de la reproducción.
    if (to > ORDER.indexOf('PLAYING') && from < ORDER.indexOf('PLAYING')) return false
    this.current = next
    return true
  }
}

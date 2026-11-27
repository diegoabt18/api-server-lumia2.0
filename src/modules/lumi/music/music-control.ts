/**
 * Controles de la música que Lumia pone en su navegador (`browser.media.control` del agente):
 * pausa, reanudar, siguiente, anterior, adelantar/retroceder, volumen y «¿qué suena?».
 *
 * Las órdenes se reconocen sin modelo, a partir del texto normalizado (minúsculas, sin acentos).
 * Los valores (segundos, volumen) salen siempre del mensaje, nunca del modelo.
 */

export type MusicControlAction =
  | 'status'
  | 'pause'
  | 'resume'
  | 'next'
  | 'previous'
  | 'seek'
  | 'volume'

export interface MusicControl {
  action: MusicControlAction
  /** `seek`: segundos a mover (negativo = retroceder), -600..600. */
  seconds?: number
  /** `volume`: nivel absoluto 0..100. */
  volume?: number
  /** `volume`: cambio sobre el nivel actual, -100..100. */
  change?: number
}

export const MAX_SEEK_SECONDS = 600
/** «sube el volumen» sin cantidad. */
export const VOLUME_STEP = 10

const OBJECT = '(?: (?:la |el |esta |este )?(?:musica|cancion|reproduccion|video|tema))?'
const UNIT = '(segundos?|segs?|s|minutos?|mins?|m)'

function seconds(amount: string, unit: string | undefined): number {
  const n = amount === 'un' || amount === 'una' ? 1 : Number(amount)
  const factor = unit && /^m/.test(unit) ? 60 : 1
  return Math.min(MAX_SEEK_SECONDS, n * factor)
}

function level(n: string): number {
  return Math.min(100, Number(n))
}

/** Orden de control, o null si el mensaje no es una de ellas. */
export function parseMusicControl(normalized: string): MusicControl | null {
  const t = normalized
    .trim()
    .replace(/^[¿¡\s]+/, '')
    .replace(/[\s?!.¿¡]+$/, '')
    .replace(/\s+/g, ' ')
  if (!t) return null

  // Comandos del chat de Lumia Admin.
  if (/^\/(?:pause|pausa|pausar)$/.test(t)) return { action: 'pause' }
  if (/^\/(?:resume|reanudar|reanuda|continuar|continua|play)$/.test(t)) return { action: 'resume' }
  if (/^\/(?:next|siguiente|skip|salta|saltar)$/.test(t)) return { action: 'next' }
  if (/^\/(?:previous|prev|anterior|back|atras)$/.test(t)) return { action: 'previous' }
  if (/^\/(?:now|sonando|suena|nowplaying|status)$/.test(t)) return { action: 'status' }
  let m = new RegExp(`^\\/seek ([+-]?)(\\d{1,4}) ?${UNIT}?$`).exec(t)
  if (m) {
    const s = seconds(m[2]!, m[3]) * (m[1] === '-' ? -1 : 1)
    return s === 0 ? null : { action: 'seek', seconds: s }
  }
  m = new RegExp(
    `^\\/(adelanta|avanza|forward|ff|retrocede|atrasa|rewind|rw) (\\d{1,4}) ?${UNIT}?$`,
  ).exec(t)
  if (m) {
    const back = /^(?:retrocede|atrasa|rewind|rw)$/.test(m[1]!)
    const s = seconds(m[2]!, m[3]) * (back ? -1 : 1)
    return s === 0 ? null : { action: 'seek', seconds: s }
  }
  m = /^\/(?:volume|volumen|vol) ([+-]?)(\d{1,3}) ?%?$/.exec(t)
  if (m) {
    const n = level(m[2]!)
    if (m[1]) return n === 0 ? null : { action: 'volume', change: m[1] === '-' ? -n : n }
    return { action: 'volume', volume: n }
  }

  // Frases.
  if (new RegExp(`^(?:pausa|pausar|pon(?:er)? (?:en )?pausa)${OBJECT}$`).test(t))
    return { action: 'pause' }
  if (
    new RegExp(
      `^(?:deten|detener|para|parar)(?: (?:la |el |esta |este )?(?:musica|cancion|reproduccion|video|tema))$`,
    ).test(t)
  ) {
    return { action: 'pause' }
  }
  if (
    new RegExp(`^(?:reanuda|reanudar|continua|continuar|quita la pausa|despausa)${OBJECT}$`).test(
      t,
    ) ||
    /^(?:sigue|seguir) (?:con )?(?:la musica|la cancion)$/.test(t)
  ) {
    return { action: 'resume' }
  }
  if (
    /^(?:(?:pon|reproduce|pasa a|ve a) )?(?:la )?siguiente(?: cancion| video| tema)?$/.test(t) ||
    /^(?:salta|saltate|saltar|pasa)(?: (?:esta|la|de) cancion| este tema)?$/.test(t) ||
    /^(?:cambia (?:de|la) cancion|otra cancion|cancion siguiente)$/.test(t)
  ) {
    return { action: 'next' }
  }
  if (
    /^(?:(?:pon|reproduce|vuelve a|regresa a) )?(?:la )?anterior(?: cancion| video| tema)?$/.test(
      t,
    ) ||
    /^cancion anterior$/.test(t)
  ) {
    return { action: 'previous' }
  }
  m = new RegExp(
    `^(adelanta|avanza|retrocede|atrasa|regresa|rebobina)${OBJECT} (\\d{1,4}|un|una) ?${UNIT}$`,
  ).exec(t)
  if (m) {
    const back = !/^(?:adelanta|avanza)$/.test(m[1]!)
    const s = seconds(m[2]!, m[3]) * (back ? -1 : 1)
    return s === 0 ? null : { action: 'seek', seconds: s }
  }
  m =
    /^(sube|subir|aumenta|baja|bajar|disminuye)(?: el)? volumen(?: (?:en |un )?(\d{1,3}) ?%?)?$/.exec(
      t,
    )
  if (m) {
    const n = m[2] ? level(m[2]) : VOLUME_STEP
    if (n === 0) return null
    return { action: 'volume', change: /^(?:baja|bajar|disminuye)$/.test(m[1]!) ? -n : n }
  }
  m =
    /^(?:(?:pon|ajusta|cambia|deja) )?(?:el )?volumen (?:al |a |en )?(\d{1,3}) ?(?:%|por ciento)?$/.exec(
      t,
    )
  if (m) return { action: 'volume', volume: level(m[1]!) }
  if (/^(?:silencia|silenciar|mutea|mutear)(?: (?:la )?musica)?$/.test(t))
    return { action: 'volume', volume: 0 }
  if (
    /^que (?:cancion |musica |tema |video )?(?:suena|esta sonando|estoy escuchando)(?: ahora)?$/.test(
      t,
    ) ||
    /^que (?:cancion|tema) es esta$/.test(t)
  ) {
    return { action: 'status' }
  }
  return null
}

/** Argumentos de `browser.media.control` para el agente. */
export function controlArgs(control: MusicControl): Record<string, unknown> {
  return {
    action: control.action,
    ...(control.seconds !== undefined ? { seconds: control.seconds } : {}),
    ...(control.volume !== undefined ? { volume: control.volume } : {}),
    ...(control.change !== undefined ? { change: control.change } : {}),
  }
}

function clock(totalSeconds: unknown): string {
  const s = Math.max(0, Math.round(Number(totalSeconds) || 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`
}

function shown(title: unknown): string {
  const text = typeof title === 'string' ? title.replace(/\s+/g, ' ').trim() : ''
  return text ? `«${text.length > 90 ? `${text.slice(0, 90)}…` : text}»` : 'la canción'
}

/** Fallos propios de los controles; los demás los explica el texto general de equipos. */
export const CONTROL_ERROR_TEXT: Record<string, string> = {
  NO_MEDIA_TAB:
    'no hay música sonando en el navegador de Lumia. Pide una canción con «/music canción y artista»',
  AD_PLAYING:
    'está sonando un anuncio de YouTube y no deja adelantar ni cambiar de canción hasta que termine. Vuelve a pedirlo en unos segundos',
  NO_NEXT_VIDEO: 'YouTube no ofrece una canción siguiente para este vídeo',
  NO_PREVIOUS_VIDEO: 'no hay una canción anterior en esta sesión de música',
  PLAYBACK_BLOCKED: 'el navegador no dejó reanudar la reproducción',
  PLAYBACK_FAILED: 'la música no volvió a sonar',
  VIDEO_UNAVAILABLE: 'YouTube no puede reproducir ese vídeo',
  VERIFICATION_FAILED: 'el reproductor no cambió, así que no puedo confirmar que se aplicó',
  BROWSER_UNAVAILABLE: 'el navegador de Lumia se cerró',
}

/**
 * Respuesta tras un control verificado por el agente (`result` del agente). Solo afirma lo que el
 * reproductor confirmó.
 */
export function controlReply(
  control: MusicControl,
  result: Record<string, unknown>,
  device: string,
): string {
  const title = shown(result.title)
  const where = `en «${device}»`
  const ad = result.ad === true
  switch (control.action) {
    case 'status': {
      if (ad) return `Ahora mismo suena un anuncio de YouTube antes de ${title} ${where}.`
      const position = `${clock(result.position_s)} de ${clock(result.duration_s)}`
      const volume = typeof result.volume === 'number' ? `, volumen ${result.volume} %` : ''
      const muted = result.muted === true ? ', silenciada' : ''
      return result.paused === true
        ? `${title} está en pausa ${where} (${position}${volume}${muted}).`
        : `Está sonando ${title} ${where} (${position}${volume}${muted}).`
    }
    case 'pause':
      return result.already === true
        ? `${title} ya estaba en pausa ${where}.`
        : `Pausé ${title} ${where}.`
    case 'resume':
      return result.already === true
        ? `${title} ya estaba sonando ${where}.`
        : `${title} vuelve a sonar ${where}.`
    case 'next':
      return `Ahora suena ${title} ${where}.`
    case 'previous':
      return `Volví a ${title} ${where}; está sonando.`
    case 'seek': {
      const moved = Math.abs(control.seconds ?? 0)
      const verb = (control.seconds ?? 0) < 0 ? 'Retrocedí' : 'Adelanté'
      return `${verb} ${moved} s: ${title} va por ${clock(result.position_s)} ${where}.`
    }
    case 'volume': {
      const now = typeof result.volume === 'number' ? result.volume : control.volume
      const before = typeof result.from === 'number' ? ` (antes ${result.from} %)` : ''
      return now === 0
        ? `Silencié la música ${where}${before}.`
        : `Volumen del reproductor al ${now} % ${where}${before}.`
    }
  }
}

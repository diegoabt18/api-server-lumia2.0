/**
 * Cálculo de horarios del motor de automatización. Funciones puras, sin I/O.
 * Las horas locales se interpretan en la zona indicada (predeterminada America/Bogota) usando Intl,
 * así que no depende de la zona horaria del servidor.
 */

export const DEFAULT_AUTOMATION_TIMEZONE = 'America/Bogota'

export type LumiSchedule =
  | { type: 'once'; runAt: Date }
  | { type: 'daily'; time: string; timezone: string }

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/

export function isValidTime(value: string): boolean {
  return TIME_PATTERN.test(value)
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone })
    return true
  } catch {
    return false
  }
}

interface ZonedParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

function zonedParts(date: Date, timezone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date)
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0)
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  }
}

/** Desplazamiento (ms) de la zona respecto a UTC en el instante dado. */
function offsetMs(date: Date, timezone: string): number {
  const p = zonedParts(date, timezone)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  const truncated = Math.floor(date.getTime() / 1000) * 1000
  return asUtc - truncated
}

/** Convierte una fecha/hora local de la zona indicada a un instante UTC. */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute)
  let instant = naive - offsetMs(new Date(naive), timezone)
  // Segunda pasada por si el desplazamiento cambia alrededor del instante calculado.
  instant = naive - offsetMs(new Date(instant), timezone)
  return new Date(instant)
}

/**
 * Próxima ocurrencia diaria a `time` en `timezone`, estrictamente posterior a `after`.
 * Si el servidor estuvo apagado varios días, devuelve la siguiente ocurrencia futura: no genera
 * ejecuciones atrasadas en cadena.
 */
export function nextDailyRun(time: string, timezone: string, after: Date): Date {
  const [hour, minute] = time.split(':').map(Number) as [number, number]
  const local = zonedParts(after, timezone)
  let candidate = zonedTimeToUtc(local.year, local.month, local.day, hour, minute, timezone)
  if (candidate.getTime() <= after.getTime()) {
    const tomorrow = new Date(Date.UTC(local.year, local.month - 1, local.day + 1))
    candidate = zonedTimeToUtc(
      tomorrow.getUTCFullYear(),
      tomorrow.getUTCMonth() + 1,
      tomorrow.getUTCDate(),
      hour,
      minute,
      timezone,
    )
  }
  return candidate
}

/** Primera ejecución de un horario al crear o reanudar. `null` si ya no tiene ejecuciones futuras. */
export function firstRunAt(schedule: LumiSchedule, now: Date): Date | null {
  if (schedule.type === 'once') return schedule.runAt
  return nextDailyRun(schedule.time, schedule.timezone, now)
}

/** Fecha local (AAAA-MM-DD) de un instante en la zona indicada. Clave de revisiones diarias. */
export function localDateKey(date: Date, timezone: string): string {
  const p = zonedParts(date, timezone)
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}

/** Hora local (0-23 y minuto) de un instante en la zona indicada. */
export function localTime(date: Date, timezone: string): { hour: number; minute: number } {
  const p = zonedParts(date, timezone)
  return { hour: p.hour, minute: p.minute }
}

/** Instante UTC de la fecha local `dayOffset` días después de `now` a la hora indicada. */
export function zonedDayTime(now: Date, timezone: string, dayOffset: number, time: string): Date {
  const [hour, minute] = time.split(':').map(Number) as [number, number]
  const p = zonedParts(now, timezone)
  const shifted = new Date(Date.UTC(p.year, p.month - 1, p.day + dayOffset))
  return zonedTimeToUtc(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate(),
    hour,
    minute,
    timezone,
  )
}

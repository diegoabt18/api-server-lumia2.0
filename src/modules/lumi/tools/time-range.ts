import { localDateKey, zonedDayTime } from '../automation/domain/schedule.js'

/**
 * Periodos en lenguaje natural ("hoy", "esta semana", "últimos 7 días") convertidos a un rango de
 * fechas en la zona de la tienda. Función pura: las herramientas nunca dejan que el modelo calcule fechas.
 */

export interface TimeRange {
  from: Date
  to: Date
  /** Etiqueta para la respuesta: "hoy", "esta semana (desde el lunes 9 de nov.)"... */
  label: string
}

const NUMBER_WORDS: Record<string, number> = {
  un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9,
  diez: 10, quince: 15, treinta: 30, noventa: 90,
}

const MAX_DAYS = 366

function dayStart(now: Date, timezone: string, offset: number): Date {
  return zonedDayTime(now, timezone, offset, '00:00')
}

/** 0 = lunes … 6 = domingo, en la zona dada. */
function weekdayIndex(now: Date, timezone: string): number {
  const [y, m, d] = localDateKey(now, timezone).split('-').map(Number) as [number, number, number]
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7
}

function dayOfMonth(now: Date, timezone: string): number {
  return Number(localDateKey(now, timezone).slice(8, 10))
}

/**
 * Busca un periodo en un texto ya normalizado (sin tildes, minúsculas). Devuelve null si no hay
 * ninguno: cada herramienta decide su periodo por defecto.
 */
export function parseTimeRange(normalized: string, now: Date, timezone: string): TimeRange | null {
  const last = /\bultim[oa]s? (\d{1,3}|[a-z]+) dias?\b/.exec(normalized)
  if (last) {
    const raw = last[1]!
    const n = /^\d+$/.test(raw) ? Number(raw) : NUMBER_WORDS[raw]
    if (n && n >= 1 && n <= MAX_DAYS) {
      return { from: dayStart(now, timezone, -(n - 1)), to: now, label: `los últimos ${n} días` }
    }
  }
  if (/\b(ultima semana|ultimos siete dias)\b/.test(normalized)) {
    return { from: dayStart(now, timezone, -6), to: now, label: 'los últimos 7 días' }
  }
  if (/\bultimo mes\b/.test(normalized)) {
    return { from: dayStart(now, timezone, -29), to: now, label: 'los últimos 30 días' }
  }
  if (/\bantier\b|\banteayer\b/.test(normalized)) {
    return { from: dayStart(now, timezone, -2), to: dayStart(now, timezone, -1), label: 'anteayer' }
  }
  if (/\bayer\b/.test(normalized)) {
    return { from: dayStart(now, timezone, -1), to: dayStart(now, timezone, 0), label: 'ayer' }
  }
  if (/\bhoy\b|\beste dia\b/.test(normalized)) {
    return { from: dayStart(now, timezone, 0), to: now, label: 'hoy' }
  }
  if (/\bsemana pasada\b/.test(normalized)) {
    const monday = -weekdayIndex(now, timezone)
    return {
      from: dayStart(now, timezone, monday - 7),
      to: dayStart(now, timezone, monday),
      label: 'la semana pasada',
    }
  }
  if (/\b(esta|en la) semana\b/.test(normalized)) {
    return { from: dayStart(now, timezone, -weekdayIndex(now, timezone)), to: now, label: 'esta semana' }
  }
  if (/\bmes pasado\b/.test(normalized)) {
    const firstOfMonth = -(dayOfMonth(now, timezone) - 1)
    const startThis = dayStart(now, timezone, firstOfMonth)
    // Primer día del mes anterior: un día antes del 1, y desde ahí al día 1 de ese mes.
    const lastPrevDay = new Date(startThis.getTime() - 1)
    const prevFirstOffset = firstOfMonth - dayOfMonth(lastPrevDay, timezone)
    return { from: dayStart(now, timezone, prevFirstOffset), to: startThis, label: 'el mes pasado' }
  }
  if (/\b(este|en el) mes\b/.test(normalized)) {
    return { from: dayStart(now, timezone, -(dayOfMonth(now, timezone) - 1)), to: now, label: 'este mes' }
  }
  return null
}

export function todayRange(now: Date, timezone: string): TimeRange {
  return { from: dayStart(now, timezone, 0), to: now, label: 'hoy' }
}

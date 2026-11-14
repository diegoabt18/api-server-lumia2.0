import { describe, expect, it } from 'vitest'
import {
  firstRunAt,
  isValidTime,
  isValidTimezone,
  nextDailyRun,
  zonedTimeToUtc,
} from '../../src/modules/lumi/automation/domain/schedule.js'
import { retryDelayMs } from '../../src/modules/lumi/automation/services/automation-worker.js'

describe('lumi automation — horarios', () => {
  it('convierte la hora local de America/Bogota (UTC-5) a UTC', () => {
    expect(zonedTimeToUtc(2026, 11, 13, 8, 0, 'America/Bogota').toISOString()).toBe('2026-11-13T13:00:00.000Z')
  })

  it('calcula la siguiente ejecución diaria del mismo día si aún no llega la hora', () => {
    // 07:00 hora Bogotá → hoy a las 08:00
    const after = new Date('2026-11-13T12:00:00.000Z')
    expect(nextDailyRun('08:00', 'America/Bogota', after).toISOString()).toBe('2026-11-13T13:00:00.000Z')
  })

  it('pasa al día siguiente cuando la hora ya ocurrió hoy', () => {
    // 09:00 hora Bogotá → mañana a las 08:00
    const after = new Date('2026-11-13T14:00:00.000Z')
    expect(nextDailyRun('08:00', 'America/Bogota', after).toISOString()).toBe('2026-11-14T13:00:00.000Z')
  })

  it('es estrictamente posterior: en el instante exacto programa el día siguiente', () => {
    const after = new Date('2026-11-13T13:00:00.000Z')
    expect(nextDailyRun('08:00', 'America/Bogota', after).toISOString()).toBe('2026-11-14T13:00:00.000Z')
  })

  it('no encadena ejecuciones atrasadas: tras varios días apagado devuelve la siguiente futura', () => {
    const after = new Date('2026-11-20T15:00:00.000Z')
    expect(nextDailyRun('08:00', 'America/Bogota', after).toISOString()).toBe('2026-11-21T13:00:00.000Z')
  })

  it('respeta otras zonas horarias', () => {
    // 08:00 en Tokio (UTC+9) = 23:00 UTC del día anterior
    expect(zonedTimeToUtc(2026, 11, 13, 8, 0, 'Asia/Tokyo').toISOString()).toBe('2026-11-12T23:00:00.000Z')
  })

  it('firstRunAt devuelve runAt tal cual para tareas puntuales', () => {
    const runAt = new Date('2026-12-01T10:00:00.000Z')
    expect(firstRunAt({ type: 'once', runAt }, new Date('2026-11-13T00:00:00.000Z'))).toEqual(runAt)
  })

  it('valida horas y zonas horarias', () => {
    expect(isValidTime('08:00')).toBe(true)
    expect(isValidTime('23:59')).toBe(true)
    expect(isValidTime('24:00')).toBe(false)
    expect(isValidTime('8:00')).toBe(false)
    expect(isValidTimezone('America/Bogota')).toBe(true)
    expect(isValidTimezone('Mars/Olympus')).toBe(false)
  })

  it('el backoff de reintentos crece y se acota a 15 minutos', () => {
    expect(retryDelayMs(1)).toBe(60_000)
    expect(retryDelayMs(2)).toBe(120_000)
    expect(retryDelayMs(3)).toBe(240_000)
    expect(retryDelayMs(10)).toBe(15 * 60_000)
  })
})

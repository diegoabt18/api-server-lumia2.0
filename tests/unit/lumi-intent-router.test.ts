import { describe, expect, it } from 'vitest'
import {
  needsReasoning,
  needsWebSearch,
  resolveLumiModes,
} from '../../src/modules/lumi/services/lumi-intent-router.js'

// El enrutado de pedidos (antes routeMessage) vive ahora en el catálogo de herramientas:
// ver tests/unit/lumi-tools.test.ts.

describe('modo automático', () => {
  it('activates web search only for current-events questions', () => {
    expect(needsWebSearch('¿Quién es actualmente el presidente de Colombia?')).toBe(true)
    expect(needsWebSearch('últimas noticias de la industria')).toBe(true)
    // Datos del mundo real: clima y divisas, aunque no mencionen actualidad.
    expect(needsWebSearch('a cuántos grados esta Cúcuta hoy')).toBe(true)
    expect(needsWebSearch('cuál es el pronóstico del tiempo en Bogotá')).toBe(true)
    expect(needsWebSearch('¿va a llover mañana en Medellín?')).toBe(true)
    expect(needsWebSearch('precio del dólar hoy')).toBe(true)
    // Preguntas de la tienda o sencillas no van a internet.
    expect(needsWebSearch('crea una descripción para esta vela')).toBe(false)
    expect(needsWebSearch('hola')).toBe(false)
  })

  it('activates reasoning only for comparisons and deep analysis', () => {
    expect(needsReasoning('compara estas fuentes e identifica contradicciones')).toBe(true)
    expect(needsReasoning('analiza las ventas del último trimestre')).toBe(true)
    expect(needsReasoning('hola')).toBe(false)
    expect(needsReasoning('crea una descripción para esta vela de lavanda con mucho detalle')).toBe(false)
  })
})

describe('resolveLumiModes', () => {
  const base = { message: 'hola', canWeb: true }

  it('lets manual controls win over the automatic rules', () => {
    const forcedOff = resolveLumiModes({
      ...base,
      message: '¿Quién es actualmente el presidente de Colombia?',
      reasoningMode: 'off',
      webMode: 'off',
    })
    expect(forcedOff).toEqual({ reasoning: false, webSearch: false, webDenied: false })

    const forcedOn = resolveLumiModes({ ...base, reasoningMode: 'on', webMode: 'on' })
    expect(forcedOn).toEqual({ reasoning: true, webSearch: true, webDenied: false })
  })

  it('keeps everything off by default for simple messages', () => {
    expect(resolveLumiModes({ ...base, reasoningMode: 'auto', webMode: 'auto' })).toEqual({
      reasoning: false,
      webSearch: false,
      webDenied: false,
    })
  })

  it('runs automatic web search only when the user can use it', () => {
    const message = '¿Quién es actualmente el presidente de Colombia?'
    expect(
      resolveLumiModes({ message, canWeb: true, reasoningMode: 'auto', webMode: 'auto' }).webSearch,
    ).toBe(true)
    expect(
      resolveLumiModes({ message, canWeb: false, reasoningMode: 'auto', webMode: 'auto' }),
    ).toEqual({ reasoning: false, webSearch: false, webDenied: false })
  })

  it('flags an explicit web request without permission', () => {
    expect(
      resolveLumiModes({ ...base, canWeb: false, reasoningMode: 'auto', webMode: 'on' }).webDenied,
    ).toBe(true)
  })
})

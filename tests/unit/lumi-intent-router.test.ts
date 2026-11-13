import { describe, expect, it, vi } from 'vitest'
import {
  ORDERS_RECENT_DEFAULT,
  ORDERS_RECENT_MAX,
  needsReasoning,
  needsWebSearch,
  resolveLumiModes,
  routeMessage,
} from '../../src/modules/lumi/services/lumi-intent-router.js'
import {
  NO_ORDERS_PERMISSION_ANSWER,
  answerRecentOrders,
  formatRecentOrders,
} from '../../src/modules/lumi/services/lumi-orders-tool.js'

describe('routeMessage', () => {
  it('routes "últimos N pedidos" to the orders tool with that limit', () => {
    expect(routeMessage('Muéstrame los últimos 10 pedidos')).toEqual({
      kind: 'orders_recent',
      limit: 10,
    })
    expect(routeMessage('ultimos 3 pedidos')).toEqual({ kind: 'orders_recent', limit: 3 })
  })

  it('uses the default limit when no number is given', () => {
    expect(routeMessage('dame los pedidos más recientes')).toEqual({
      kind: 'orders_recent',
      limit: ORDERS_RECENT_DEFAULT,
    })
  })

  it('clamps the limit to the allowed range', () => {
    expect(routeMessage('últimos 99 pedidos')).toEqual({
      kind: 'orders_recent',
      limit: ORDERS_RECENT_MAX,
    })
  })

  it('sends everything else to the model', () => {
    expect(routeMessage('hola')).toEqual({ kind: 'model' })
    expect(routeMessage('crea una descripción para esta vela')).toEqual({ kind: 'model' })
    // Mencionar pedidos sin pedir una lista reciente no activa la herramienta.
    expect(routeMessage('¿qué es un pedido?')).toEqual({ kind: 'model' })
  })
})

describe('modo automático', () => {
  it('activates web search only for current-events questions', () => {
    expect(needsWebSearch('¿Quién es actualmente el presidente de Colombia?')).toBe(true)
    expect(needsWebSearch('últimas noticias de la industria')).toBe(true)
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

describe('answerRecentOrders', () => {
  it('does not read orders without permission', async () => {
    const fetchRows = vi.fn(async () => [])
    const text = await answerRecentOrders(false, 10, fetchRows)
    expect(text).toBe(NO_ORDERS_PERMISSION_ANSWER)
    expect(fetchRows).not.toHaveBeenCalled()
  })

  it('reads with the requested limit and formats the rows', async () => {
    const fetchRows = vi.fn(async () => [
      { orderNumber: 'ORD-9', createdAt: '2026-11-13T08:00:00.000Z', status: 'new', paymentStatus: 'pending', total: 50 },
    ])
    const text = await answerRecentOrders(true, 3, fetchRows)
    expect(fetchRows).toHaveBeenCalledWith(3)
    expect(text).toContain('#ORD-9')
  })
})

describe('formatRecentOrders', () => {
  it('lists order number, date, statuses and total without customer data', () => {
    const text = formatRecentOrders(
      [
        {
          orderNumber: 'ORD-1',
          createdAt: '2026-11-12T10:00:00.000Z',
          status: 'paid',
          paymentStatus: 'paid',
          total: 120,
        },
      ],
      10,
    )
    expect(text).toBe(
      'Pedidos (1):\n1. #ORD-1 · 2026-11-12 · estado: paid · pago: paid · total: 120',
    )
  })

  it('says so when there are no orders', () => {
    expect(formatRecentOrders([], 10)).toBe('No hay pedidos registrados.')
  })

  it('fills missing fields with a dash', () => {
    const text = formatRecentOrders(
      [{ orderNumber: null, createdAt: null, status: null, paymentStatus: null, total: null }],
      1,
    )
    expect(text).toContain('#— · — · estado: — · pago: — · total: —')
  })
})

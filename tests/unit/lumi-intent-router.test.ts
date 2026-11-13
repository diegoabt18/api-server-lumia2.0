import { describe, expect, it } from 'vitest'
import {
  ORDERS_RECENT_DEFAULT,
  ORDERS_RECENT_MAX,
  routeMessage,
} from '../../src/modules/lumi/services/lumi-intent-router.js'
import { formatRecentOrders } from '../../src/modules/lumi/services/lumi-orders-tool.js'

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

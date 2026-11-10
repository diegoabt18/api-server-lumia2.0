import { describe, it, expect, vi } from 'vitest'

vi.mock('../../src/config/env.js', () => ({ getEnv: () => ({ ORDER_NUMBER_PREFIX: 'ORD' }) }))

const { OrderRepository } = await import('../../src/modules/sales/infrastructure/order.repository.js')

describe('número de pedido', () => {
  it('tiene prefijo, fecha, hora de Bogotá y 8 caracteres aleatorios', async () => {
    const number = await OrderRepository.prototype.generateOrderNumber.call({})
    expect(number).toMatch(/^ORD-\d{8}-\d{6}-[0-9A-F]{8}$/)

    const bogota = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date()).replace(/-/g, '')
    expect(number.slice(4, 12)).toBe(bogota)
  })

  it('no es secuencial: dos pedidos seguidos tienen sufijos distintos', async () => {
    const a = await OrderRepository.prototype.generateOrderNumber.call({})
    const b = await OrderRepository.prototype.generateOrderNumber.call({})
    expect(a).not.toBe(b)
  })
})

import { describe, it, expect, vi } from 'vitest'
import { OrderService } from '../../src/modules/sales/services/order.service.js'

const owned = { id: 'o1', userId: 'user-A', orderNumber: 'ORD-20261108-190244-07E593E4', customerReference: 'ORD-07E593E4', items: [], total: 1, status: 'pending', createdAt: new Date(), customerName: 'Ana', phone: '1', address: 'x', city: 'y', reference: '' }

function make() {
  const orders = {
    findByUser: vi.fn(async (userId: string, id: string) => (userId === 'user-A' && id === 'o1' ? owned : null)),
    findByOrderNumber: vi.fn(async (code: string) => (code === 'ORD-07E593E4' || code === owned.orderNumber ? owned : null)),
    findByIdSafe: vi.fn(async () => owned),
  }
  return { service: new OrderService(orders as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never), orders }
}

describe('propiedad de pedidos', () => {
  it('el dueño obtiene su pedido', async () => {
    const { service } = make()
    await expect(service.getById('o1', 'user-A')).resolves.toMatchObject({ id: 'o1' })
  })

  it('otro usuario recibe 404 aunque el pedido exista (no revela su existencia)', async () => {
    const { service, orders } = make()
    await expect(service.getById('o1', 'user-B')).rejects.toMatchObject({ statusCode: 404 })
    expect(orders.findByIdSafe).not.toHaveBeenCalled()
  })

  it('un invitado (sin sesión) no obtiene el detalle por id', async () => {
    const { service } = make()
    await expect(service.getById('o1', null)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('la referencia corta solo resuelve el id para su dueño', async () => {
    const { service } = make()
    await expect(service.getIdByOrderNumber('ORD-07E593E4', 'user-A')).resolves.toEqual({ id: 'o1' })
    await expect(service.getIdByOrderNumber('ORD-07E593E4', 'user-B')).rejects.toMatchObject({ statusCode: 404 })
    await expect(service.getIdByOrderNumber('ORD-07E593E4', null)).rejects.toMatchObject({ statusCode: 404 })
  })
})

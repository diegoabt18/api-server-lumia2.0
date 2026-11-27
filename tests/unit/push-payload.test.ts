import { describe, expect, it } from 'vitest'
import { preOrderPushData } from '../../src/modules/notifications/services/push.service.js'
import type { OrderDomain } from '../../src/modules/sales/domain/order.entity.js'

const order = {
  id: '665f1c2a9b1e8a0012345678',
  orderNumber: 'ORD-2026-000123',
  total: 125000,
  items: [{ quantity: 2 }, { quantity: 1 }],
  customerName: 'Ana Privada',
  phone: '3001112233',
  whatsapp: '573001112233',
  email: 'ana.privada@example.com',
  address: 'Calle 1 # 2-3',
} as unknown as OrderDomain

describe('push de pedido nuevo: sin datos personales', () => {
  it('lleva solo identificadores y totales del pedido', () => {
    const data = preOrderPushData(order)
    expect(Object.keys(data).sort()).toEqual(
      ['body', 'itemCount', 'orderId', 'orderNumber', 'title', 'total', 'type'].sort(),
    )
    expect(data).toMatchObject({ orderNumber: 'ORD-2026-000123', total: '125000', itemCount: '3' })
  })

  it('ningún dato del cliente aparece en ningún campo', () => {
    const serialized = JSON.stringify(preOrderPushData(order))
    for (const secret of [
      'Ana Privada',
      '3001112233',
      '573001112233',
      'ana.privada@example.com',
      'Calle 1',
    ]) {
      expect(serialized).not.toContain(secret)
    }
  })
})

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../src/config/env.js', () => ({ getEnv: () => ({ ORDER_NUMBER_PREFIX: 'ORD' }) }))

const { OrderRepository, customerReferenceOf } = await import('../../src/modules/sales/infrastructure/order.repository.js')

describe('referencia corta del cliente', () => {
  it('se deriva del número interno sin cambiarlo', () => {
    expect(customerReferenceOf('ORD-20261108-185352-CB07203E')).toBe('ORD-CB07203E')
  })

  it('el término de búsqueda se escapa: no se interpreta como expresión regular', () => {
    const filter = OrderRepository.prototype['buildAdminSearchFilter'].call({}, 'a.*+(') as { $or: Array<{ customerReference: { $regex: string } }> }
    expect(filter.$or[0]!.customerReference.$regex).toBe('^a\\.' + '\\*' + '\\+' + '\\(')
  })

  it('una referencia corta completa busca por igualdad exacta indexada', () => {
    const filter = OrderRepository.prototype['buildAdminSearchFilter'].call({}, 'ord-cb07203e') as { $or: unknown[] }
    expect(filter.$or[0]).toEqual({ customerReference: 'ORD-CB07203E' })
  })

  it('solo el sufijo busca la referencia completa', () => {
    const filter = OrderRepository.prototype['buildAdminSearchFilter'].call({}, 'cb07203e') as { $or: unknown[] }
    expect(filter.$or[0]).toEqual({ customerReference: 'ORD-CB07203E' })
  })
})

import { describe, it, expect } from 'vitest'
import { AdminOrderService } from '../../src/modules/admin/services/admin-order.service.js'

describe('anticipo por porcentaje del pedido (retirado en G3)', () => {
  const service = new AdminOrderService({} as never, {} as never, {} as never, {} as never)

  it('configurar un porcentaje sobre el total queda rechazado', async () => {
    await expect(service.configureDeposit('o1', 30, 'admin')).rejects.toThrow(/fue retirado/)
  })

  it('registrar pagos por las acciones heredadas queda rechazado; se usa el libro de pagos', async () => {
    await expect(service.markDepositPaid('o1', 100, 'admin')).rejects.toThrow(/libro de pagos/)
    await expect(service.markFinalPaymentPaid('o1', 100, 'admin')).rejects.toThrow(/libro de pagos/)
  })
})

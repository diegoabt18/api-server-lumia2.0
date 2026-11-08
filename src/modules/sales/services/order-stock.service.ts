import type { InventoryRepository } from '../../catalog/infrastructure/inventory.repository.js'
import type { OrderRepository } from '../infrastructure/order.repository.js'
import type { OrderEntity } from '../domain/order.entity.js'

/**
 * Descuento y devolución de stock de pedidos. Regla única para todos los caminos de pago:
 *  - Se descuenta al quedar pagado (pago manual confirmado, pago final o pago en línea).
 *  - Se devuelve al cancelar, solo si el stock de esa orden se había descontado.
 *  - Solo se descuentan variantes con control de inventario (las de pedido no tienen stock).
 * El marcador `stockDecrementedAt` se reclama de forma atómica, así que no hay doble descuento.
 */
export class OrderStockService {
  constructor(
    private readonly inventory: InventoryRepository,
    private readonly orders: OrderRepository,
  ) {}

  /** Devuelve true si esta llamada descontó el stock; false si ya estaba descontado. */
  async applyOnPaid(order: OrderEntity): Promise<boolean> {
    if (!order._id) return false
    const claimed = await this.orders.claimStockDecrement(order._id)
    if (!claimed) return false

    const failures: string[] = []
    for (const item of order.items) {
      const sku = item.variantSku
      if (!sku) {
        failures.push(`${item.productId}: sin SKU de variante`)
        continue
      }
      const availability = await this.inventory.getBySku(sku)
      // Sin registro de inventario o con venta por pedido: no hay stock que descontar.
      if (!availability || availability.isPerOrder) continue
      const ok = await this.inventory.decrementAtomic(sku, item.quantity)
      if (!ok) failures.push(`${sku}: sin existencias suficientes`)
    }
    await this.orders.recordInventoryFailure(order._id, failures)
    return true
  }

  /** Devuelve el stock solo si la orden lo había descontado y aún no se devolvió. */
  async restoreIfDecremented(order: OrderEntity): Promise<boolean> {
    if (!order._id || !order.stockDecrementedAt || order.stockRestoredAt) return false
    const claimed = await this.orders.markStockRestored(order._id)
    if (!claimed) return false

    for (const item of order.items) {
      const sku = item.variantSku
      if (!sku) continue
      const availability = await this.inventory.getBySku(sku)
      if (!availability || availability.isPerOrder) continue
      await this.inventory.incrementAtomic(sku, item.quantity)
    }
    return true
  }
}

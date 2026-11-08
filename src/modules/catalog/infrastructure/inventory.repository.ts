import type { Db } from 'mongodb'
import { getCollection } from '../../../database/repositories/base.repository.js'
import type { InventoryItemEntity, VariantEntity } from '../domain/catalog.entity.js'

export interface InventoryAvailability {
  available: number
  isPerOrder: boolean
}

export interface InventoryMovementInput {
  sku: string
  type: 'pos_sale' | 'pos_cancelled' | 'adjustment'
  quantityDelta: number
  orderId?: string
  orderNumber?: string
  actorId?: string | null
  reason?: string
}

export interface InventoryMovementEntity extends InventoryMovementInput {
  createdAt: Date
}

export class InventoryRepository {
  private readonly collection
  private readonly variants
  private readonly movements

  constructor(db: Db) {
    this.collection = getCollection<InventoryItemEntity>(db, 'inventory_items')
    this.variants = getCollection<VariantEntity>(db, 'variants')
    this.movements = getCollection<InventoryMovementEntity>(db, 'inventory_movements')
  }

  async ensureIndexes(): Promise<void> {
    await this.movements.createIndexes([
      { key: { orderId: 1 } },
      { key: { sku: 1, createdAt: -1 } },
      { key: { createdAt: -1 } },
    ])
  }

  /**
   * Descuento atómico de stock disponible (quantity - reserved >= quantity).
   * Devuelve false si no hay existencias suficientes; no modifica nada en ese caso.
   */
  async decrementAtomic(sku: string, quantity: number): Promise<boolean> {
    if (quantity <= 0) return true
    const result = await this.collection.updateOne(
      {
        sku,
        $expr: {
          $gte: [
            { $subtract: ['$quantity', { $ifNull: ['$reserved', 0] }] },
            quantity,
          ],
        },
      } as never,
      {
        $inc: { quantity: -quantity },
        $set: { updated_at: new Date() },
      } as never,
    )
    return result.modifiedCount > 0
  }

  /** Compensación de una venta fallida o cancelación. */
  async incrementAtomic(sku: string, quantity: number): Promise<void> {
    if (quantity <= 0) return
    await this.collection.updateOne(
      { sku } as never,
      { $inc: { quantity }, $set: { updated_at: new Date() } } as never,
    )
  }

  async logMovement(input: InventoryMovementInput): Promise<void> {
    await this.movements.insertOne({ ...input, createdAt: new Date() } as never)
  }

  async listMovementsByOrder(orderId: string): Promise<InventoryMovementEntity[]> {
    return this.movements.find({ orderId } as never).sort({ createdAt: 1 }).toArray()
  }

  async getBySku(sku: string): Promise<InventoryAvailability | null> {
    const item = await this.collection.findOne({ sku })
    if (!item) return null
    const reserved = item.reserved ?? 0
    return {
      available: Math.max(0, item.quantity - reserved),
      isPerOrder: item.is_per_order === true,
    }
  }

  async mapAvailableBySkus(skus: string[]): Promise<Map<string, number>> {
    if (!skus.length) return new Map()
    const list = await this.collection.find({ sku: { $in: skus } }).toArray()
    const map = new Map<string, number>()
    for (const item of list) {
      const reserved = item.reserved ?? 0
      map.set(item.sku, Math.max(0, item.quantity - reserved))
    }
    return map
  }

  async listAdmin(skip: number, limit: number, search?: string) {
    const filter: Record<string, unknown> = {}
    if (search?.trim()) {
      const rx = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      filter.$or = [{ sku: rx }, { warehouse: rx }]
    }

    const [items, total] = await Promise.all([
      this.collection.find(filter as never).sort({ updated_at: -1 }).skip(skip).limit(limit).toArray(),
      this.collection.countDocuments(filter as never),
    ])

    const skus = items.map((i) => i.sku)
    const variantDocs = skus.length
      ? await this.variants.find({ sku: { $in: skus } }).project({ sku: 1, description: 1, product_slug: 1 }).toArray()
      : []
    const variantMap = new Map(variantDocs.map((v) => [v.sku, v]))

    const rows = items.map((i) => {
      const variant = variantMap.get(i.sku)
      const reserved = i.reserved ?? 0
      return {
        sku: i.sku,
        quantity: i.quantity,
        reserved,
        available: Math.max(0, i.quantity - reserved),
        warehouse: i.warehouse ?? 'main',
        isPerOrder: i.is_per_order ?? false,
        variantName: variant?.description ?? null,
        productSlug: variant?.product_slug ?? null,
        updatedAt: i.updated_at?.toISOString?.() ?? null,
      }
    })

    return { items: rows, total }
  }

  async upsertBySku(data: {
    sku: string
    quantity: number
    reserved?: number
    warehouse?: string
    is_per_order?: boolean
  }): Promise<void> {
    const now = new Date()
    const existing = await this.collection.findOne({ sku: data.sku })
    const reserved = data.reserved ?? existing?.reserved ?? 0
    await this.collection.updateOne(
      { sku: data.sku },
      {
        $set: {
          sku: data.sku,
          quantity: data.quantity,
          reserved,
          warehouse: data.warehouse ?? existing?.warehouse ?? 'main',
          is_per_order: data.is_per_order ?? existing?.is_per_order ?? false,
          updated_at: now,
        },
      },
      { upsert: true },
    )
  }
}

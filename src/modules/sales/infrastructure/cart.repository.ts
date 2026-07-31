import type { Db } from 'mongodb'
import { BaseRepository, getCollection } from '../../../database/repositories/base.repository.js'
import type { CartEntity, CartItemEntity } from '../domain/cart.entity.js'

interface LegacyCartItem {
  sku: string
  productSlug?: string
  productId?: string
  quantity: number
  name?: string
  productName?: string
  unitPrice?: number
  currency?: string
  variantLabel?: string
  variantName?: string
  selectionLabel?: string
  imageUrl?: string
  imagePath?: string | null
}

interface CartDocument {
  cartKey?: string | null
  userId?: string | null
  items: LegacyCartItem[]
  updatedAt: Date
}

function mapLegacyItem(item: LegacyCartItem): CartItemEntity {
  return {
    sku: item.sku,
    productSlug: item.productSlug ?? item.productId ?? '',
    productName: item.productName ?? item.name ?? item.sku,
    variantLabel: item.variantLabel ?? item.variantName ?? item.selectionLabel,
    quantity: item.quantity,
    unitPrice: item.unitPrice ?? 0,
    currency: item.currency ?? 'COP',
    imagePath: item.imagePath ?? item.imageUrl ?? null,
  }
}

function toCartEntity(doc: CartDocument): CartEntity {
  const cartKey = doc.cartKey ?? doc.userId ?? ''
  return {
    cartKey,
    userId: doc.userId ?? null,
    items: (doc.items ?? []).map(mapLegacyItem),
    updatedAt: doc.updatedAt,
  }
}

export class CartRepository extends BaseRepository<CartDocument> {
  constructor(db: Db) {
    super(getCollection(db, 'carts'))
  }

  async ensureIndexes(): Promise<void> {
    await this.migrateLegacyCarts()

    await super.ensureIndexes([
      {
        key: { cartKey: 1 },
        unique: true,
        partialFilterExpression: { cartKey: { $type: 'string' } },
      },
      { key: { userId: 1 }, sparse: true },
    ])
  }

  /** Documentos del monolito usaban solo `userId`; normalizar a `cartKey`. */
  private async migrateLegacyCarts(): Promise<void> {
    const legacy = await this.collection
      .find({
        $and: [
          { $or: [{ cartKey: null }, { cartKey: { $exists: false } }] },
          { userId: { $exists: true, $type: 'string' } },
        ],
      } as never)
      .toArray()

    for (const doc of legacy) {
      if (!doc.userId) continue
      await this.collection.updateOne(
        { _id: doc._id },
        { $set: { cartKey: doc.userId, updatedAt: doc.updatedAt ?? new Date() } },
      )
    }

    // Huérfanos sin cartKey ni userId válido
    await this.collection.deleteMany({
      $or: [{ cartKey: null }, { cartKey: { $exists: false } }],
    } as never)
  }

  async findByKey(cartKey: string): Promise<CartEntity | null> {
    let doc = await this.findOne({ cartKey } as never)
    if (!doc) {
      doc = await this.findOne({ userId: cartKey } as never)
    }
    if (!doc) return null
    return toCartEntity(doc)
  }

  async save(cartKey: string, items: CartItemEntity[], userId?: string | null): Promise<CartEntity> {
    const now = new Date()
    await this.collection.updateOne(
      { $or: [{ cartKey }, { userId: cartKey }] } as never,
      { $set: { cartKey, userId: userId ?? null, items, updatedAt: now } },
      { upsert: true },
    )
    return { cartKey, userId: userId ?? null, items, updatedAt: now }
  }

  async clear(cartKey: string): Promise<void> {
    await this.save(cartKey, [], null)
  }

  async mergeGuestIntoUser(guestKey: string, userId: string): Promise<void> {
    const guest = await this.findByKey(guestKey)
    if (!guest?.items.length) return

    const userCart = await this.findByKey(userId)
    const merged = [...(userCart?.items ?? [])]

    for (const item of guest.items) {
      const idx = merged.findIndex((i) => i.sku === item.sku)
      if (idx >= 0) merged[idx].quantity += item.quantity
      else merged.push(item)
    }

    await this.save(userId, merged, userId)
    await this.clear(guestKey)
  }
}

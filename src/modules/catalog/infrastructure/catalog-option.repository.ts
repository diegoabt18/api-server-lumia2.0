import type { Db } from 'mongodb'
import { ObjectId } from 'mongodb'
import { getCollection } from '../../../database/repositories/base.repository.js'
import { MAX_OPTION_AXES_PER_PRODUCT } from '../../../common/config/catalog-config.js'
import type {
  LegacyProductOption,
  ProductOptionAxisEntity,
  ProductOptionValueEntity,
  ProductOptionWithValues,
} from '../domain/catalog-option.entity.js'

const AXES = 'product_option_axes'
const VALS = 'product_option_values'

function slugify(input: string): string {
  return (
    input
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'v'
  )
}

export class CatalogOptionRepository {
  private readonly axes
  private readonly vals
  private readonly legacy

  constructor(db: Db) {
    this.axes = getCollection<ProductOptionAxisEntity>(db, AXES)
    this.vals = getCollection<ProductOptionValueEntity>(db, VALS)
    this.legacy = getCollection<{ name: string; values: string[]; product_slug: string }>(db, 'product_options')
  }

  async ensureIndexes(): Promise<void> {
    await this.axes.createIndexes([
      { key: { product_id: 1, position: 1 } },
      { key: { product_id: 1, name: 1 } },
    ])
    await this.vals.createIndexes([
      { key: { option_id: 1, value: 1 }, unique: true },
      { key: { option_id: 1, slug: 1 }, unique: true },
      { key: { option_id: 1, position: 1 } },
    ])
  }

  async listAxesWithValuesByProductId(productId: string): Promise<ProductOptionWithValues[]> {
    if (!ObjectId.isValid(productId)) return []
    const pid = new ObjectId(productId)
    const axisDocs = await this.axes.find({ product_id: pid }).sort({ position: 1 }).toArray()
    if (!axisDocs.length) return []

    const axisIds = axisDocs.map((a) => a._id!)
    const valueDocs = await this.vals.find({ option_id: { $in: axisIds } }).sort({ position: 1 }).toArray()
    const byAxis = new Map<string, ProductOptionValueEntity[]>()
    for (const v of valueDocs) {
      const k = v.option_id.toString()
      if (!byAxis.has(k)) byAxis.set(k, [])
      byAxis.get(k)!.push(v)
    }

    return axisDocs.map((a) => ({
      id: a._id!.toString(),
      name: a.name,
      position: a.position,
      values: (byAxis.get(a._id!.toString()) ?? []).map((v) => ({
        id: v._id!.toString(),
        optionId: v.option_id.toString(),
        value: v.value,
        slug: v.slug,
        position: v.position,
        createdAt: v.created_at?.toISOString?.(),
      })),
    }))
  }

  async listLegacyOptionsByProductSlug(productSlug: string): Promise<LegacyProductOption[]> {
    const docs = await this.legacy.find({ product_slug: productSlug, values: { $exists: true } }).toArray()
    return docs.map((d) => ({ name: d.name, values: d.values ?? [] }))
  }

  async replaceCatalogForProduct(
    productId: string,
    axes: Array<{
      name: string
      position: number
      values: Array<{ value: string; position: number; slug?: string }>
    }>,
  ): Promise<void> {
    if (!ObjectId.isValid(productId)) throw new Error('INVALID_PRODUCT_ID')
    if (axes.length > MAX_OPTION_AXES_PER_PRODUCT) {
      throw new Error(`Máximo ${MAX_OPTION_AXES_PER_PRODUCT} ejes de opción por producto`)
    }
    const pid = new ObjectId(productId)
    const existingAxes = await this.axes.find({ product_id: pid }).project({ _id: 1 }).toArray()
    const oldAxisIds = existingAxes.map((a) => a._id!)
    if (oldAxisIds.length) {
      await this.vals.deleteMany({ option_id: { $in: oldAxisIds } })
      await this.axes.deleteMany({ _id: { $in: oldAxisIds } })
    }
    const now = new Date()
    for (const ax of axes) {
      const { insertedId: axisId } = await this.axes.insertOne({
        product_id: pid,
        name: ax.name.trim(),
        position: ax.position,
        created_at: now,
      } as never)
      const usedSlugs = new Set<string>()
      for (const vv of ax.values) {
        let s = vv.slug?.trim() || slugify(vv.value)
        let n = 0
        while (usedSlugs.has(s)) {
          n += 1
          s = `${slugify(vv.value)}-${n}`
        }
        usedSlugs.add(s)
        await this.vals.insertOne({
          option_id: axisId,
          value: vv.value.trim(),
          slug: s,
          position: vv.position,
          created_at: now,
        } as never)
      }
    }
  }

  async clearLegacyOptions(productSlug: string): Promise<void> {
    await this.legacy.deleteMany({ product_slug: productSlug })
  }
}

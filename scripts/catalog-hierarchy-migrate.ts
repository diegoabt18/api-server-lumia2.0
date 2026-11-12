/**
 * Migración no destructiva de la jerarquía Categoría → Subcategoría → Producto.
 *
 * - Por defecto NO escribe nada: muestra un informe (dry-run).
 * - Con --apply solo crea índices nuevos (subcategories, products.subcategory_id).
 * - Nunca asigna subcategorías a productos existentes: los productos sin subcategoría se listan
 *   para clasificación manual desde lumia-admin.
 *
 * Uso:
 *   npm run db:catalog-hierarchy            (dry-run)
 *   npm run db:catalog-hierarchy -- --apply (crea índices)
 */
import { MongoClient } from 'mongodb'
import { loadEnv, MONGO_DB_NAMES } from '../src/config/env.js'
import { createScriptLogger } from '../src/config/logger.js'

async function main() {
  const apply = process.argv.includes('--apply')
  const env = loadEnv()
  const logger = createScriptLogger()

  const client = new MongoClient(env.MONGO_AUTH_URI)
  await client.connect()
  try {
    const catalogDb = client.db(MONGO_DB_NAMES.catalog)
    const categories = catalogDb.collection('categories')
    const subcategories = catalogDb.collection('subcategories')
    const products = catalogDb.collection('products')

    const categoryCount = await categories.countDocuments({})
    const subcategoryCount = await subcategories.countDocuments({})
    const productCount = await products.countDocuments({})
    const unclassified = await products
      .find({ subcategory_id: { $exists: false } }, { projection: { name: 1, slug: 1, category_slug: 1, status: 1 } })
      .sort({ name: 1 })
      .toArray()

    const nameDuplicates = await categories
      .aggregate([
        { $group: { _id: { $toLower: '$name' }, n: { $sum: 1 }, slugs: { $push: '$slug' } } },
        { $match: { n: { $gt: 1 } } },
      ])
      .toArray()

    logger.info(
      { categories: categoryCount, subcategories: subcategoryCount, products: productCount },
      'Estado actual de la jerarquía de catálogo',
    )

    if (unclassified.length) {
      logger.warn(
        {
          count: unclassified.length,
          products: unclassified.map((p) => ({
            slug: p.slug,
            name: p.name,
            legacyCategorySlug: p.category_slug ?? null,
            status: p.status ?? 'active',
          })),
        },
        'Productos sin subcategoría: requieren clasificación manual (no se asignan automáticamente)',
      )
    } else {
      logger.info('Todos los productos tienen subcategoría asignada')
    }

    if (nameDuplicates.length) {
      logger.warn({ duplicates: nameDuplicates }, 'Categorías con nombres duplicados (revisar manualmente)')
    }

    if (apply) {
      await subcategories.createIndex({ category_id: 1, slug: 1 }, { unique: true })
      await subcategories.createIndex({ category_id: 1, status: 1, sort_order: 1 })
      await products.createIndex({ subcategory_id: 1 })
      logger.info('Índices creados (--apply)')
    } else {
      logger.info('Dry-run: no se ha escrito nada. Usa --apply para crear los índices.')
    }
  } finally {
    await client.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

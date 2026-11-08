/**
 * Recalcula `average_rating` y `reviews_count` de todos los productos a partir de las reseñas
 * visibles (product_reviews en sales_db, sin `hidden`). Idempotente: vuelve a calcular todo.
 *
 * Uso:
 *   npm run db:recalculate-ratings              → dry-run: muestra cuántos productos cambiarían
 *   npm run db:recalculate-ratings -- --apply   → escribe en catalog_db.products
 *
 * Usa MONGO_SALES_URI (lectura) y MONGO_CATALOG_URI (escritura) de la configuración del servidor.
 */
import { MongoClient } from 'mongodb'
import { loadEnv, MONGO_DB_NAMES } from '../src/config/env.js'

interface RatingRow {
  _id: string
  average: number
  count: number
}

async function main() {
  const apply = process.argv.includes('--apply')
  const env = loadEnv()
  const salesClient = new MongoClient(env.MONGO_SALES_URI)
  const catalogClient = env.MONGO_CATALOG_URI === env.MONGO_SALES_URI ? salesClient : new MongoClient(env.MONGO_CATALOG_URI)
  await salesClient.connect()
  if (catalogClient !== salesClient) await catalogClient.connect()

  try {
    const reviews = salesClient.db(MONGO_DB_NAMES.sales).collection('product_reviews')
    const products = catalogClient.db(MONGO_DB_NAMES.catalog).collection('products')

    const rows = await reviews
      .aggregate<RatingRow>([
        { $match: { hidden: { $ne: true } } },
        { $group: { _id: '$product_slug', average: { $avg: '$stars' }, count: { $sum: 1 } } },
      ])
      .toArray()
    const byProduct = new Map(rows.map((row) => [String(row._id), row]))

    const allProducts = await products
      .find({}, { projection: { slug: 1, average_rating: 1, reviews_count: 1 } })
      .toArray()

    let changed = 0
    const operations = allProducts.map((product) => {
      const row = byProduct.get(String(product.slug))
      const average = row ? Math.round(row.average * 10) / 10 : 0
      const count = row ? row.count : 0
      const current = product as { average_rating?: number; reviews_count?: number }
      if (current.average_rating !== average || current.reviews_count !== count) changed++
      return {
        updateOne: {
          filter: { _id: product._id },
          update: { $set: { average_rating: average, reviews_count: count, updated_at: new Date() } },
        },
      }
    })

    console.log(`Productos: ${allProducts.length} · con reseñas visibles: ${rows.length} · cambiarían: ${changed}`)

    if (!apply) {
      console.log('Dry-run: no se escribió nada. Ejecuta con --apply para guardar.')
      return
    }
    if (operations.length) await products.bulkWrite(operations, { ordered: false })
    console.log(`Actualizados ${operations.length} productos (${changed} con valores distintos).`)
  } finally {
    await salesClient.close()
    if (catalogClient !== salesClient) await catalogClient.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

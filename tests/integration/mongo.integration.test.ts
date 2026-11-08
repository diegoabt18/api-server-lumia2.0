/**
 * Pruebas de integración contra MongoDB real. Solo se ejecutan si MONGO_TEST_URI está definida,
 * y nunca deben apuntar a Atlas ni a la base de producción: usan una base temporal que se borra al final.
 *
 *   MONGO_TEST_URI=mongodb://127.0.0.1:27018 npm run test:integration
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { MongoClient, ObjectId, type Db } from 'mongodb'
import { ReviewRepository } from '../../src/modules/sales/infrastructure/review.repository.js'
import { QuestionRepository } from '../../src/modules/sales/infrastructure/question.repository.js'
import { MaterialSupplierRepository } from '../../src/modules/production/infrastructure/material-supplier.repository.js'

const uri = process.env.MONGO_TEST_URI
const describeIfDb = uri ? describe : describe.skip

describeIfDb('MongoDB integration (base temporal)', () => {
  let client: MongoClient
  let db: Db
  const dbName = `test_integration_${Date.now()}`

  beforeAll(async () => {
    client = new MongoClient(uri as string, { serverSelectionTimeoutMS: 8000 })
    await client.connect()
    db = client.db(dbName)
  })

  afterAll(async () => {
    if (db) await db.dropDatabase()
    await client?.close()
  })

  describe('índices de reacciones', () => {
    it('crea los índices únicos en una base vacía y es idempotente', async () => {
      const reviews = new ReviewRepository(db)
      const questions = new QuestionRepository(db)
      await reviews.ensureIndexes()
      await reviews.ensureIndexes()
      await questions.ensureIndexes()
      await questions.ensureIndexes()

      const idx = await db.collection('review_reactions').indexes()
      expect(idx.find((i) => i.key.review_id === 1 && i.key.user_id === 1)?.unique).toBe(true)
    })

    it('acepta un índice único ya existente con el nombre automático (caso producción)', async () => {
      const legacy = client.db(`test_legacy_${Date.now()}`)
      try {
        await legacy.collection('question_reactions').createIndex({ question_id: 1, user_id: 1 }, { unique: true })
        await legacy.collection('review_reactions').createIndex({ review_id: 1, user_id: 1 }, { unique: true })
        await expect(new QuestionRepository(legacy).ensureIndexes()).resolves.not.toThrow()
        await expect(new ReviewRepository(legacy).ensureIndexes()).resolves.not.toThrow()
      } finally {
        await legacy.dropDatabase()
      }
    })
  })

  describe('reseñas', () => {
    it('upsert por usuario no duplica y el resumen usa solo reseñas visibles', async () => {
      const reviews = new ReviewRepository(db)
      await reviews.ensureIndexes()
      const slug = 'vela-test'
      const ana = { id: 'user-ana', name: 'Ana', avatar: '' }
      const luis = { id: 'user-luis', name: 'Luis', avatar: '' }

      await reviews.upsert(slug, ana, { stars: 5, body: 'Excelente' }, true)
      await reviews.upsert(slug, ana, { stars: 4, body: 'Muy buena' }, true) // edición, no segunda reseña
      await reviews.upsert(slug, luis, { stars: 3 }, false)

      const count = await db.collection('product_reviews').countDocuments({ product_slug: slug })
      expect(count).toBe(2)

      const summary = await reviews.visibleRatingSummary(slug)
      expect(summary).toEqual({ average: 3.5, count: 2 })

      const anaDoc = await db.collection('product_reviews').findOne({ product_slug: slug, user_id: ana.id })
      await db.collection('product_reviews').updateOne({ _id: anaDoc!._id }, { $set: { hidden: true } })
      expect(await reviews.visibleRatingSummary(slug)).toEqual({ average: 3, count: 1 })
    })

    it('reacciones: rechaza ids inválidos y reseñas ocultas, y acepta una reseña visible', async () => {
      const reviews = new ReviewRepository(db)
      const slug = 'vela-reacciones'
      await reviews.upsert(slug, { id: 'user-x', name: 'X', avatar: '' }, { stars: 5 }, true)
      const doc = await db.collection('product_reviews').findOne({ product_slug: slug })
      const id = String(doc!._id)

      expect(await reviews.react('no-es-un-objectid', 'user-y', 'helpful')).toBe(false)
      expect(await reviews.react(id, 'user-y', 'helpful')).toBe(true)

      await db.collection('product_reviews').updateOne({ _id: doc!._id }, { $set: { hidden: true } })
      expect(await reviews.react(id, 'user-z', 'helpful')).toBe(false)
    })
  })

  describe('proveedores por material', () => {
    it('vincula, lista con nombre de proveedor y desvincula', async () => {
      const links = new MaterialSupplierRepository(db)
      const materialId = new ObjectId()
      const supplierId = new ObjectId()
      await db.collection('suppliers').insertOne({ _id: supplierId, name: 'Proveedor Test' } as never)

      await links.link(String(materialId), String(supplierId), true)
      await links.link(String(materialId), String(supplierId), true) // idempotente
      const listed = await links.listForMaterial(String(materialId))
      expect(listed).toEqual([{ supplierId: String(supplierId), supplierName: 'Proveedor Test', isPreferred: true }])

      await links.unlink(String(materialId), String(supplierId))
      expect(await links.listForMaterial(String(materialId))).toEqual([])
    })

    it('devuelve lista vacía para ids no válidos sin consultar la base', async () => {
      const links = new MaterialSupplierRepository(db)
      expect(await links.listForMaterial('no-valido')).toEqual([])
    })
  })
})

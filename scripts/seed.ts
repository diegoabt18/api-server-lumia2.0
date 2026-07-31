import bcrypt from 'bcryptjs'
import { MongoClient } from 'mongodb'
import { loadEnv, MONGO_DB_NAMES } from '../src/config/env.js'
import { createScriptLogger } from '../src/config/logger.js'

async function seed() {
  const env = loadEnv()
  const logger = createScriptLogger()

  if (env.DB_SEED_DISABLED) {
    logger.info('DB_SEED_DISABLED=true — skipping seed')
    return
  }

  const client = new MongoClient(env.MONGO_AUTH_URI)
  await client.connect()
  const identityDb = client.db(MONGO_DB_NAMES.identity)
  const catalogDb = client.db(MONGO_DB_NAMES.catalog)

  const users = identityDb.collection('users')
  const categories = catalogDb.collection('categories')
  const products = catalogDb.collection('products')
  const variants = catalogDb.collection('variants')
  const inventory = catalogDb.collection('inventory_items')

  const adminEmail = 'admin@lumiadalistore.com'
  const existingAdmin = await users.findOne({ email: adminEmail })

  if (!existingAdmin || env.DB_SEED_FORCE) {
    const passwordHash = await bcrypt.hash('Admin123!', 12)
    await users.updateOne(
      { email: adminEmail },
      {
        $set: {
          email: adminEmail,
          nickname: 'admin',
          passwordHash,
          role: 'admin',
          isStaff: true,
          provider: 'local',
          permissionsVersion: 1,
          permissionUpdatedAt: new Date(),
          updatedAt: new Date(),
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true },
    )
    logger.info({ email: adminEmail }, 'Admin user seeded (password: Admin123!)')
  }

  const catSlug = 'velas'
  await categories.updateOne(
    { slug: catSlug },
    {
      $set: { name: 'Velas', slug: catSlug, createdAt: new Date() },
    },
    { upsert: true },
  )

  const productSlug = 'vela-lavanda-demo'
  await products.updateOne(
    { slug: productSlug },
    {
      $set: {
        name: 'Vela Lavanda Demo',
        slug: productSlug,
        description: 'Vela aromática de lavanda — producto de demostración',
        category_slug: catSlug,
        status: 'active',
        image_path: '/products/vela-lavanda-demo',
        sales_total_units: 10,
        updated_at: new Date(),
      },
      $setOnInsert: { created_at: new Date() },
    },
    { upsert: true },
  )

  const sku = 'VEL-LAV-001'
  await variants.updateOne(
    { sku },
    {
      $set: {
        product_slug: productSlug,
        sku,
        options: { Tamaño: 'Mediana' },
        price: 45000,
        currency: 'COP',
        created_at: new Date(),
      },
    },
    { upsert: true },
  )

  await inventory.updateOne(
    { sku },
    {
      $set: {
        sku,
        quantity: 100,
        reserved: 0,
        warehouse: 'main',
        is_per_order: false,
        updated_at: new Date(),
      },
    },
    { upsert: true },
  )

  logger.info('Seed completed')
  await client.close()
}

seed().catch((err) => {
  console.error(err)
  process.exit(1)
})

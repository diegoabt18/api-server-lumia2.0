/**
 * Completa en `identity_db.store_payment_settings` los metadatos de presentación de los métodos
 * de pago (nombre, descripción, tiempo estimado) que hoy solo existen como valores por defecto
 * en el código. Así la base de datos pasa a ser la fuente de verdad.
 *
 * Reglas:
 *   - No sobrescribe nada que ya esté guardado: solo rellena campos ausentes.
 *   - No cambia `isActive` de ningún método.
 *   - Por defecto es un dry-run: muestra los cambios y no escribe nada.
 *
 * Uso:
 *   npm run db:seed-payment-methods                 → muestra el plan (dry-run)
 *   npm run db:seed-payment-methods -- --apply      → escribe en MONGO_AUTH_URI
 */
import { MongoClient } from 'mongodb'
import { loadEnv, MONGO_DB_NAMES } from '../src/config/env.js'
import {
  AVAILABLE_PAYMENT_METHODS,
  type PaymentMethodInfo,
} from '../src/modules/payments/domain/payment-method.js'

type StoredMethod = {
  methodId: string
  isActive: boolean
  displayName?: string
  description?: string
  estimatedProcessingTime?: string
}

const COLLECTION = 'store_payment_settings'
const DOC_ID = 'default'

function withMissingMetadata(stored: StoredMethod[], defaults: PaymentMethodInfo[]): StoredMethod[] {
  const result = stored.map((method) => ({ ...method }))
  for (const info of defaults) {
    const index = result.findIndex((m) => m.methodId === info.id)
    if (index === -1) {
      // Method entirely missing: add it enabled-by-default, same as the read-side default.
      result.push({
        methodId: info.id,
        isActive: true,
        displayName: info.displayName,
        description: info.description,
        estimatedProcessingTime: info.estimatedProcessingTime,
      })
      continue
    }
    const entry = result[index]
    if (!entry.displayName) entry.displayName = info.displayName
    if (!entry.description) entry.description = info.description
    if (!entry.estimatedProcessingTime) entry.estimatedProcessingTime = info.estimatedProcessingTime
  }
  return result
}

async function main() {
  const apply = process.argv.includes('--apply')
  const env = loadEnv()
  const client = new MongoClient(env.MONGO_AUTH_URI)
  await client.connect()

  try {
    const collection = client.db(MONGO_DB_NAMES.identity).collection(COLLECTION)
    const doc = await collection.findOne({ _id: DOC_ID } as never)
    const stored = ((doc?.methods as StoredMethod[] | undefined) ?? []).map((m) => ({ ...m }))
    const next = withMissingMetadata(stored, AVAILABLE_PAYMENT_METHODS)

    const changed = JSON.stringify(next) !== JSON.stringify(stored)
    console.log(`Documento ${COLLECTION}/${DOC_ID}: ${doc ? 'existe' : 'no existe (se creará)'}`)
    console.log(JSON.stringify(next, null, 2))

    if (!changed) {
      console.log('Sin cambios: la configuración ya contiene todos los metadatos.')
      return
    }
    if (!apply) {
      console.log('\nDry-run: no se escribió nada. Ejecuta con --apply para guardar.')
      return
    }

    await collection.updateOne(
      { _id: DOC_ID } as never,
      { $set: { methods: next, updatedAt: new Date() }, $setOnInsert: { _id: DOC_ID } },
      { upsert: true },
    )
    console.log('\nConfiguración de métodos de pago actualizada.')
  } finally {
    await client.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

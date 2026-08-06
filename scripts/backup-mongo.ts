/**
 * Backup manual de las 4 bases MongoDB.
 * Uso: npm run backup:mongo
 * Requiere mongodump instalado en el host.
 */
import { execSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { loadEnv, MONGO_DB_NAMES } from '../src/config/env.js'

const env = loadEnv()
const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
const outDir = `./backups/${timestamp}`

mkdirSync(outDir, { recursive: true })

const uriByKey = {
  identity: env.MONGO_AUTH_URI,
  catalog: env.MONGO_CATALOG_URI,
  sales: env.MONGO_SALES_URI,
  production: env.MONGO_PRODUCTION_URI,
} as const

for (const [key, dbName] of Object.entries(MONGO_DB_NAMES)) {
  const uri = uriByKey[key as keyof typeof uriByKey]
  console.log(`Backing up ${dbName}...`)
  execSync(`mongodump --uri="${uri}" --db=${dbName} --out="${outDir}"`, {
    stdio: 'inherit',
  })
}

console.log(`Backup completed: ${outDir}`)

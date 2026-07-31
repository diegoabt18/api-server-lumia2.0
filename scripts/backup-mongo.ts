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

for (const [, dbName] of Object.entries(MONGO_DB_NAMES)) {
  console.log(`Backing up ${dbName}...`)
  execSync(`mongodump --uri="${env.MONGO_AUTH_URI}" --db=${dbName} --out="${outDir}"`, {
    stdio: 'inherit',
  })
}

console.log(`Backup completed: ${outDir}`)

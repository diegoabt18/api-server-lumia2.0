/**
 * Copia las 4 bases MongoDB de producción (.env.production) hacia desarrollo.
 *
 * Uso:
 *   npm run db:sync-from-prod              → restaura en Mongo local Docker (localhost:27017)
 *   npm run db:sync-from-prod -- --target=development  → restaura en URIs de .env.development
 *
 * Usa mongodump/mongorestore del host si están en PATH; si no, los ejecuta vía Docker (mongo:7).
 * Requisito: Mongo destino levantado (npm run docker:dev:local).
 */
import { execSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'dotenv'
import { MONGO_DB_NAMES } from '../src/config/env.js'

const DB_KEYS = ['identity', 'catalog', 'sales', 'production'] as const

const URI_BY_KEY = {
  identity: 'MONGO_AUTH_URI',
  catalog: 'MONGO_CATALOG_URI',
  sales: 'MONGO_SALES_URI',
  production: 'MONGO_PRODUCTION_URI',
} as const

const LOCAL_DOCKER_URI = 'mongodb://lumia:lumia_secret@127.0.0.1:27017/?authSource=admin'
/** URI equivalente cuando mongorestore corre dentro de un contenedor Docker en Windows/Mac. */
const LOCAL_FROM_CONTAINER_URI =
  'mongodb://lumia:lumia_secret@host.docker.internal:27017/?authSource=admin'

type Runner = 'host' | 'docker'

function loadEnvFile(filename: string): Record<string, string> {
  const path = resolve(process.cwd(), filename)
  if (!existsSync(path)) {
    throw new Error(`No existe ${filename}`)
  }
  return parse(readFileSync(path))
}

function hasHostTool(name: string): boolean {
  const found = spawnSync(name, ['--version'], { shell: true, stdio: 'ignore' })
  return found.status === 0
}

function detectRunner(): Runner {
  if (hasHostTool('mongodump') && hasHostTool('mongorestore')) {
    return 'host'
  }
  const docker = spawnSync('docker', ['info'], { stdio: 'ignore' })
  if (docker.status === 0) {
    console.log('mongodump/mongorestore no están en PATH — usando contenedor mongo:7\n')
    return 'docker'
  }
  throw new Error(
    'Necesitas mongodump/mongorestore en PATH o Docker en ejecución.\n' +
      'Opcional (host): winget install MongoDB.DatabaseTools',
  )
}

function toContainerUri(uri: string): string {
  return uri.replace('127.0.0.1', 'host.docker.internal').replace('localhost', 'host.docker.internal')
}

function runDump(runner: Runner, uri: string, dbName: string, outDir: string): void {
  if (runner === 'host') {
    run(`mongodump --uri="${uri}" --db=${dbName} --out="${outDir}"`)
    return
  }

  const mount = resolve(outDir, '..')
  run(
    `docker run --rm -v "${mount}:/backup" mongo:7 mongodump --uri="${uri}" --db=${dbName} --out="/backup/${dbName}"`,
  )
}

function runRestore(runner: Runner, uri: string, dbName: string, dumpPath: string): void {
  if (runner === 'host') {
    run(`mongorestore --uri="${uri}" --db=${dbName} --drop "${dumpPath}"`)
    return
  }

  const mount = resolve(dumpPath, '..', '..')
  const inContainerDump = `/backup/${dbName}/${dbName}`
  run(
    `docker run --rm -v "${mount}:/backup" mongo:7 mongorestore --uri="${uri}" --db=${dbName} --drop "${inContainerDump}"`,
  )
}

function run(cmd: string): void {
  console.log(`> ${cmd}`)
  execSync(cmd, { stdio: 'inherit', shell: true })
}

const targetArg = process.argv.find((a) => a.startsWith('--target='))
const target = targetArg?.split('=')[1] ?? 'local'

const runner = detectRunner()

const source = loadEnvFile('.env.production')
const development = target === 'development' ? loadEnvFile('.env.development') : null

const workDir = resolve('./backups/sync-from-prod')
rmSync(workDir, { recursive: true, force: true })
mkdirSync(workDir, { recursive: true })

console.log(`Origen: .env.production`)
console.log(`Destino: ${target === 'local' ? 'Mongo Docker local (localhost:27017)' : '.env.development'}`)
console.log(`Runner: ${runner === 'host' ? 'herramientas locales' : 'Docker mongo:7'}\n`)

for (const key of DB_KEYS) {
  const dbName = MONGO_DB_NAMES[key]
  const uriKey = URI_BY_KEY[key]
  const sourceUri = source[uriKey]
  if (!sourceUri) {
    throw new Error(`Falta ${uriKey} en .env.production`)
  }

  let targetUri =
    target === 'local' ? LOCAL_DOCKER_URI : (development?.[uriKey] ?? LOCAL_DOCKER_URI)

  if (runner === 'docker' && target === 'local') {
    targetUri = LOCAL_FROM_CONTAINER_URI
  } else if (runner === 'docker' && target === 'development') {
    targetUri = toContainerUri(targetUri)
  }

  const dumpDir = resolve(workDir, dbName)
  mkdirSync(dumpDir, { recursive: true })

  console.log(`=== ${dbName} ===`)
  runDump(runner, sourceUri, dbName, dumpDir)
  runRestore(runner, targetUri, dbName, resolve(dumpDir, dbName))
  console.log('')
}

console.log('Sync completado.')
if (target === 'local') {
  console.log('Mongo Express: http://localhost:8081 (admin / admin)')
}

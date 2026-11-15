/**
 * Orquestador E2E del ecosistema Lumia: levanta los TRES proyectos reales y los conecta como en
 * producción. Nada se simula salvo el modelo (Ollama), que se sustituye por un servidor
 * determinista que cuenta sus llamadas.
 *
 *   navegador (pruebas) ──▶ Lumia Admin BFF (.output, Nitro) ──▶ Server (dist) ──▶ MongoDB desechable
 *                                                                   └──▶ local-ai-assistant (uvicorn) ──▶ Ollama simulado
 *
 * Requisitos: MongoDB DESECHABLE en loopback (p. ej. `docker run --rm -p 127.0.0.1:27018:27017 mongo:7`),
 * `npm run build` en server, `npm run build` en lumia-admin y un Python con las dependencias del
 * asistente. Las bases identity_db, catalog_db, sales_db y production_db de esa instancia se BORRAN.
 *
 * Variables: E2E_MONGO_URI (mongodb://127.0.0.1:27018), E2E_ADMIN_DIR (../lumia-admin),
 * E2E_IA_DIR (../local-ai-assistant), E2E_IA_PYTHON (python).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import bcrypt from 'bcryptjs'
import { MongoClient, ObjectId } from 'mongodb'
import type { TestProject } from 'vitest/node'

const SERVER_DIR = path.resolve(import.meta.dirname, '../..')
const ADMIN_DIR = path.resolve(process.env.E2E_ADMIN_DIR ?? path.join(SERVER_DIR, '../lumia-admin'))
const IA_DIR = path.resolve(process.env.E2E_IA_DIR ?? path.join(SERVER_DIR, '../local-ai-assistant'))
const IA_PYTHON = process.env.E2E_IA_PYTHON ?? 'python'
const MONGO_URI = process.env.E2E_MONGO_URI ?? 'mongodb://127.0.0.1:27018'

const PORTS = { server: 3998, admin: 3199, ia: 8799, ollama: 11499 }
export const FAKE_MODEL_REPLY = 'Respuesta de prueba del modelo simulado.'

const children: ChildProcess[] = []
let ollama: http.Server | null = null
let tmp = ''

function assertDisposableMongo(uri: string) {
  const host = new URL(uri.replace(/^mongodb(\+srv)?:/, 'http:')).hostname
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) || uri.startsWith('mongodb+srv')) {
    throw new Error(`E2E_MONGO_URI debe ser un MongoDB local y desechable (recibido host ${host})`)
  }
}

/** Ollama simulado: /api/tags, /api/chat (stream NDJSON o JSON). Cuenta las llamadas al modelo. */
function startFakeOllama(): Promise<void> {
  let calls = 0
  // Último cuerpo recibido en /api/chat: permite comprobar qué prompt llegó al modelo.
  let last: unknown = null
  ollama = http.createServer((req, res) => {
    if (req.url === '/__calls') {
      res.end(JSON.stringify({ calls }))
      return
    }
    if (req.url === '/__last') {
      res.end(JSON.stringify({ last }))
      return
    }
    if (req.url === '/api/tags') {
      res.end(JSON.stringify({ models: [{ name: 'fake-model' }] }))
      return
    }
    if (req.url === '/api/chat' && req.method === 'POST') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        calls += 1
        const payload = JSON.parse(body) as { stream?: boolean }
        last = payload
        const done = { done: true, prompt_eval_count: 11, eval_count: 7 }
        if (payload.stream) {
          res.setHeader('Content-Type', 'application/x-ndjson')
          for (const word of FAKE_MODEL_REPLY.split(' ')) {
            res.write(`${JSON.stringify({ message: { content: `${word} ` }, done: false })}\n`)
          }
          res.end(`${JSON.stringify({ message: { content: '' }, ...done })}\n`)
        } else {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ message: { content: FAKE_MODEL_REPLY }, ...done }))
        }
      })
      return
    }
    res.statusCode = 404
    res.end('{}')
  })
  return new Promise((resolve) => ollama!.listen(PORTS.ollama, '127.0.0.1', resolve))
}

function start(name: string, cmd: string, args: string[], cwd: string, env: Record<string, string>) {
  const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  const log: string[] = []
  const keep = (b: Buffer) => {
    log.push(b.toString())
    if (log.length > 200) log.shift()
  }
  child.stdout?.on('data', keep)
  child.stderr?.on('data', keep)
  child.on('exit', (code) => {
    if (code && code !== 0) console.error(`[e2e] ${name} terminó con código ${code}\n${log.join('').slice(-3000)}`)
  })
  children.push(child)
  return child
}

async function waitFor(url: string, name: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.status < 500) return
      last = `HTTP ${res.status}`
    } catch (err) {
      last = (err as Error).message
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`[e2e] ${name} no respondió en ${url}: ${last}`)
}

async function seed(passwords: Record<string, string>) {
  const client = new MongoClient(MONGO_URI)
  await client.connect()
  try {
    for (const db of ['identity_db', 'catalog_db', 'sales_db', 'production_db']) {
      await client.db(db).dropDatabase()
    }
    const identity = client.db('identity_db')
    const now = new Date()
    const roles = {
      super: new ObjectId(),
      limited: new ObjectId(),
      catalog: new ObjectId(),
    }
    await identity.collection('roles').insertMany([
      { _id: roles.super, key: 'e2e_super', name: 'E2E Super', permissionKeys: ['*'], createdAt: now, version: 1 },
      {
        _id: roles.limited,
        key: 'e2e_limited',
        name: 'E2E Limitado',
        permissionKeys: ['admin.access', 'admin.users.read', 'admin.users.manage', 'admin.roles.read', 'products.read'],
        createdAt: now,
        version: 1,
      },
      {
        // Lumi con catálogo, pero sin pedidos ni analítica: comprueba el filtrado por permisos.
        _id: roles.catalog,
        key: 'e2e_catalog',
        name: 'E2E Catálogo',
        permissionKeys: ['admin.access', 'lumi.use', 'products.read'],
        createdAt: now,
        version: 1,
      },
    ])
    const users: Record<string, ObjectId> = {}
    for (const [key, role] of [
      ['admin', roles.super],
      ['limited', roles.limited],
      ['locked', roles.limited],
      ['catalog', roles.catalog],
    ] as const) {
      const _id = new ObjectId()
      users[key] = _id
      await identity.collection('users').insertOne({
        _id,
        email: `${key}@e2e.test`,
        name: `E2E ${key}`,
        passwordHash: await bcrypt.hash(passwords[key]!, 4),
        role: 'user',
        isStaff: true,
        provider: 'local',
        permissionsVersion: 1,
        createdAt: now,
        updatedAt: now,
      })
      await identity.collection('user_roles').insertOne({ _id: new ObjectId(), userId: _id, roleId: role, assignedAt: now })
    }
    return {
      roleIds: { super: roles.super.toHexString(), limited: roles.limited.toHexString() },
      userIds: Object.fromEntries(Object.entries(users).map(([k, v]) => [k, v.toHexString()])),
    }
  } finally {
    await client.close()
  }
}

export default async function setup(project: TestProject) {
  assertDisposableMongo(MONGO_URI)
  for (const [what, file] of [
    ['server dist', path.join(SERVER_DIR, 'dist/server.js')],
    ['lumia-admin .output', path.join(ADMIN_DIR, '.output/server/index.mjs')],
    ['local-ai-assistant', path.join(IA_DIR, 'app/main.py')],
  ] as const) {
    if (!existsSync(file)) throw new Error(`[e2e] falta ${what}: ${file} (ejecuta el build correspondiente)`)
  }

  // Valores de prueba generados en cada ejecución: nunca se imprimen ni se guardan.
  const secret = () => randomBytes(24).toString('base64url')
  const passwords = { admin: secret(), limited: secret(), locked: secret(), catalog: secret() }
  const iaKey = secret()
  const edgeSecret = secret() + secret()
  const seeded = await seed(passwords)

  tmp = mkdtempSync(path.join(tmpdir(), 'lumia-e2e-'))
  await startFakeOllama()

  start('local-ai-assistant', IA_PYTHON, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(PORTS.ia)], IA_DIR, {
    API_KEY: iaKey,
    DATABASE_URL: `sqlite:///${path.join(tmp, 'assistant.db').replace(/\\/g, '/')}`,
    OLLAMA_BASE_URL: `http://127.0.0.1:${PORTS.ollama}`,
    OLLAMA_MODEL: 'fake-model',
    SEARXNG_BASE_URL: 'http://127.0.0.1:9',
    REDIS_HOST: '127.0.0.1',
    REDIS_PORT: '9',
    PYTHONDONTWRITEBYTECODE: '1',
  })

  start('server', process.execPath, ['dist/server.js'], SERVER_DIR, {
    NODE_ENV: 'development',
    HOST: '127.0.0.1',
    PORT: String(PORTS.server),
    APP_URL: `http://127.0.0.1:${PORTS.server}`,
    MONGO_AUTH_URI: MONGO_URI,
    MONGO_CATALOG_URI: MONGO_URI,
    MONGO_SALES_URI: MONGO_URI,
    MONGO_PRODUCTION_URI: MONGO_URI,
    JWT_SECRET: secret() + secret(),
    REDIS_ENABLED: 'false',
    EMAIL_ENABLED: 'false',
    FCM_ENABLED: 'false',
    MERCADOPAGO_ENABLED: 'false',
    AUTH_LOCAL_ENABLED: 'true',
    COOKIE_SECURE: 'false',
    COOKIE_DOMAIN: '',
    DB_SEED_DISABLED: 'true',
    LUMI_ASSISTANT_URL: `http://127.0.0.1:${PORTS.ia}`,
    LUMI_ASSISTANT_API_KEY: iaKey,
    LUMI_AUTOMATION_ENABLED: 'true',
    LUMI_AUTOMATION_TICK_MS: '5000',
    LOGIN_MAX_FAILURES: '3',
    EDGE_PROXY_SECRET: edgeSecret,
    TRUST_PROXY: 'false',
    RATE_LIMIT_MAX: '5000',
    LOG_LEVEL: 'warn',
  })

  start('lumia-admin', process.execPath, ['.output/server/index.mjs'], ADMIN_DIR, {
    HOST: '127.0.0.1',
    PORT: String(PORTS.admin),
    NITRO_HOST: '127.0.0.1',
    NITRO_PORT: String(PORTS.admin),
    NUXT_API_BASE_URL: `http://127.0.0.1:${PORTS.server}`,
    NUXT_SESSION_COOKIE_SECURE: 'false',
    NUXT_EDGE_PROXY_SECRET: edgeSecret,
  })

  await waitFor(`http://127.0.0.1:${PORTS.ia}/api/v1/health`, 'local-ai-assistant')
  await waitFor(`http://127.0.0.1:${PORTS.server}/health/ready`, 'server')
  await waitFor(`http://127.0.0.1:${PORTS.admin}/api/health`, 'lumia-admin')

  project.provide('e2e', {
    urls: {
      admin: `http://127.0.0.1:${PORTS.admin}`,
      server: `http://127.0.0.1:${PORTS.server}`,
      ia: `http://127.0.0.1:${PORTS.ia}`,
      ollama: `http://127.0.0.1:${PORTS.ollama}`,
    },
    mongoUri: MONGO_URI,
    passwords,
    iaKey,
    edgeSecret,
    ...seeded,
  })

  return async () => {
    for (const child of children) child.kill()
    await new Promise<void>((resolve) => (ollama ? ollama.close(() => resolve()) : resolve()))
    await new Promise((r) => setTimeout(r, 500))
    try {
      rmSync(tmp, { recursive: true, force: true })
    } catch {
      /* el proceso de Python puede tardar en soltar el archivo en Windows */
    }
  }
}

declare module 'vitest' {
  export interface ProvidedContext {
    e2e: {
      urls: { admin: string; server: string; ia: string; ollama: string }
      mongoUri: string
      passwords: { admin: string; limited: string; locked: string; catalog: string }
      iaKey: string
      edgeSecret: string
      roleIds: { super: string; limited: string }
      userIds: Record<string, string>
    }
  }
}

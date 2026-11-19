/**
 * Da TODOS los permisos del registro (src/common/permissions/registry.ts) a un rol, incluidos los
 * nuevos (por ejemplo music.read y music.control).
 *
 *   npm run db:grant-all-permissions                              → lista los roles y lo que le falta a cada uno
 *   npm run db:grant-all-permissions -- --role=admin              → simulación para ese rol (no escribe)
 *   npm run db:grant-all-permissions -- --role=admin --apply      → aplica
 *
 * - Solo AÑADE permisos ($addToSet): nunca quita ninguno. Es idempotente.
 * - Antes inserta en el catálogo `permissions` los que falten (igual que el Server al arrancar),
 *   para que el editor de roles de Lumia Admin los muestre.
 * - Escribe la lista explícita, no el comodín «*»: así se ve en Lumia Admin qué tiene el rol.
 * - Los permisos efectivos en caché se renuevan solos en 5 minutos como máximo (o al volver a
 *   iniciar sesión).
 */
import { MongoClient } from 'mongodb'
import { ALL_PERMISSION_IDS } from '../src/common/permissions/registry.js'
import { configureDnsForMongoSrv } from '../src/config/dns.js'
import { loadEnv, MONGO_DB_NAMES } from '../src/config/env.js'
import { PERMISSION_SEEDS } from '../src/modules/admin/config/admin-registry.seeds.js'

interface RoleDoc {
  key: string
  name?: string
  permissionKeys?: string[]
  isSystem?: boolean
  archivedAt?: Date | null
}

function parseArgs(argv: string[]): { role: string | null; apply: boolean } {
  const role = argv.find((a) => a.startsWith('--role='))?.slice('--role='.length).trim() || null
  const apply = argv.includes('--apply')
  if (apply && !role) throw new Error('Para aplicar indica el rol: --role=<clave> --apply')
  return { role, apply }
}

function missingFor(doc: RoleDoc): string[] {
  const keys = Array.isArray(doc.permissionKeys) ? doc.permissionKeys.filter((k) => typeof k === 'string') : []
  if (keys.includes('*')) return []
  return ALL_PERMISSION_IDS.filter((id) => !keys.includes(id))
}

async function main() {
  const { role, apply } = parseArgs(process.argv.slice(2))
  const env = loadEnv()
  if (env.MONGO_AUTH_URI.startsWith('mongodb+srv')) configureDnsForMongoSrv()
  const client = await new MongoClient(env.MONGO_AUTH_URI).connect()
  try {
    const db = client.db(MONGO_DB_NAMES.identity)
    const roles = db.collection<RoleDoc>('roles')

    if (!role) {
      const all = await roles.find({}, { projection: { key: 1, name: 1, permissionKeys: 1, isSystem: 1, archivedAt: 1 } }).toArray()
      console.log(`Roles (${all.length}). Permisos en el registro: ${ALL_PERMISSION_IDS.length}\n`)
      for (const r of all) {
        const missing = missingFor(r)
        const tags = [r.isSystem ? 'sistema' : null, r.archivedAt ? 'archivado' : null].filter(Boolean).join(', ')
        const state = Array.isArray(r.permissionKeys) && r.permissionKeys.includes('*') ? 'tiene «*» (todos)' : `le faltan ${missing.length}`
        console.log(`  --role=${r.key}  ·  ${r.name ?? ''}${tags ? ` (${tags})` : ''}  ·  ${state}`)
      }
      console.log('\nElige uno y ejecuta: npm run db:grant-all-permissions -- --role=<clave>')
      return
    }

    const doc = await roles.findOne({ key: role })
    if (!doc) throw new Error(`No existe el rol «${role}». Ejecuta el script sin argumentos para ver la lista.`)
    if (doc.archivedAt) throw new Error(`El rol «${role}» está archivado.`)
    const missing = missingFor(doc)

    console.log(`[${apply ? 'APLICAR' : 'SIMULACIÓN'}] Rol «${role}»: ${missing.length} permiso(s) a añadir`)
    for (const id of missing) console.log(`  + ${id}`)
    if (!apply) {
      console.log('\nNo se escribió nada. Añade --apply para aplicar.')
      return
    }

    // Catálogo: solo inserta los que falten, sin tocar los existentes.
    const catalog = db.collection('permissions')
    let inserted = 0
    for (const { key, ...rest } of PERMISSION_SEEDS) {
      const res = await catalog.updateOne({ key }, { $setOnInsert: rest }, { upsert: true })
      if (res.upsertedCount > 0) inserted++
    }
    console.log(`Catálogo de permisos: ${inserted} insertado(s).`)

    if (missing.length) {
      await roles.updateOne({ key: role }, { $addToSet: { permissionKeys: { $each: missing } }, $set: { updatedAt: new Date() } })
    }
    console.log(`Listo: el rol «${role}» tiene todos los permisos. Se aplican en ≤ 5 minutos o al volver a iniciar sesión.`)
  } finally {
    await client.close()
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})

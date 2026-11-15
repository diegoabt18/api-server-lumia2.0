/**
 * Migración ADITIVA a los permisos por módulo (promociones, banners, inventario, ajustes de tienda,
 * pagos y moderación). Ver src/modules/security/domain/module-permissions-migration.ts.
 *
 * Por defecto NO escribe nada: muestra qué añadiría. Para aplicar hay que decidir explícitamente qué
 * hacer con los permisos que hoy salen de admin.access:
 *
 *   npm run db:migrate-module-permissions                                  → simulación (ambos modos)
 *   npm run db:migrate-module-permissions -- --apply --admin-access=preserve
 *   npm run db:migrate-module-permissions -- --apply --admin-access=skip
 *
 * - Nunca quita permisos. Es idempotente: ejecutarla dos veces no cambia nada la segunda.
 * - Solo toca listas `permissionKeys` de identity_db (roles, plantillas, temporales, overrides,
 *   condicionales). No imprime datos personales: solo colección, identificador y permisos añadidos.
 * - Los permisos efectivos en caché se renuevan solos en 5 minutos como máximo.
 * - Antes de aplicarla, el catálogo de permisos debe incluir los nuevos:
 *   POST /api/admin/security/permissions/sync (solo inserta los que faltan).
 */
import { MongoClient, type Document } from 'mongodb'
import { loadEnv, MONGO_DB_NAMES } from '../src/config/env.js'
import { configureDnsForMongoSrv } from '../src/config/dns.js'
import {
  PERMISSION_LIST_COLLECTIONS,
  permissionsToAdd,
  type AdminAccessMode,
} from '../src/modules/security/domain/module-permissions-migration.js'

function parseArgs(argv: string[]): { apply: boolean; mode: AdminAccessMode | null } {
  const apply = argv.includes('--apply')
  const raw = argv.find((a) => a.startsWith('--admin-access='))?.split('=')[1]
  const mode = raw === 'preserve' || raw === 'skip' ? raw : null
  if (raw && !mode) throw new Error('--admin-access debe ser "preserve" o "skip"')
  if (apply && !mode) throw new Error('Para aplicar hay que indicar --admin-access=preserve o --admin-access=skip')
  return { apply, mode }
}

async function plan(client: MongoClient, mode: AdminAccessMode) {
  const db = client.db(MONGO_DB_NAMES.identity)
  const changes: Array<{ collection: string; id: unknown; label: string; add: string[] }> = []
  for (const name of PERMISSION_LIST_COLLECTIONS) {
    const docs = await db
      .collection(name)
      .find({ permissionKeys: { $exists: true } }, { projection: { permissionKeys: 1, key: 1, name: 1 } })
      .toArray()
    for (const doc of docs as Document[]) {
      const keys = Array.isArray(doc.permissionKeys) ? (doc.permissionKeys as unknown[]).filter((k): k is string => typeof k === 'string') : []
      const add = permissionsToAdd(keys, mode)
      if (add.length) changes.push({ collection: name, id: doc._id, label: String(doc.key ?? doc.name ?? doc._id), add })
    }
  }
  return changes
}

async function main() {
  const { apply, mode } = parseArgs(process.argv.slice(2))
  const env = loadEnv()
  if (env.MONGO_AUTH_URI.startsWith('mongodb+srv')) configureDnsForMongoSrv()
  const client = await new MongoClient(env.MONGO_AUTH_URI).connect()
  try {
    const modes: AdminAccessMode[] = mode ? [mode] : ['preserve', 'skip']
    for (const m of modes) {
      const changes = await plan(client, m)
      console.log(`\n[${apply ? 'APLICAR' : 'SIMULACIÓN'}] --admin-access=${m}: ${changes.length} lista(s) a ampliar`)
      for (const c of changes) console.log(`  ${c.collection} · ${c.label}: + ${c.add.join(', ')}`)
      if (!apply) continue
      const db = client.db(MONGO_DB_NAMES.identity)
      for (const c of changes) {
        // $addToSet: añadir sin duplicar y sin tocar el resto de la lista.
        await db.collection(c.collection).updateOne({ _id: c.id } as Document, {
          $addToSet: { permissionKeys: { $each: c.add } },
          $set: { updatedAt: new Date() },
        })
      }
      console.log(`  Aplicado: ${changes.length} lista(s).`)
    }
    if (!apply) console.log('\nNo se escribió nada. Añade --apply y --admin-access=preserve|skip para aplicar.')
  } finally {
    await client.close()
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})

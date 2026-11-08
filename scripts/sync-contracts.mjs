#!/usr/bin/env node
/**
 * Sincroniza los contratos compartidos desde server/shared/contracts hacia los frontends.
 *
 *   node scripts/sync-contracts.mjs           → copia (escribe) los contratos
 *   node scripts/sync-contracts.mjs --check   → no escribe; falla (exit 1) si hay copias desviadas
 *
 * Las copias llevan un encabezado de "generado": no se editan a mano. Se eliminan los .ts
 * de la carpeta destino que ya no existen en el origen, para no dejar contratos huérfanos.
 */
import { readdir, readFile, writeFile, mkdir, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(serverRoot, 'shared', 'contracts')
const parent = resolve(serverRoot, '..')

const targets = [
  { name: 'lumia', dir: join(parent, 'lumia', 'shared', 'contracts') },
  { name: 'lumia2.0', dir: join(parent, 'lumia2.0', 'shared', 'contracts') },
]

const HEADER =
  '// GENERADO por server/scripts/sync-contracts.mjs desde server/shared/contracts.\n' +
  '// No editar este archivo: cambia el original en el servidor y vuelve a sincronizar.\n'

const checkOnly = process.argv.includes('--check')

async function listSource() {
  const files = (await readdir(source)).filter((f) => f.endsWith('.ts')).sort()
  if (!files.length) throw new Error(`No hay contratos en ${source}`)
  return files
}

async function expected(file) {
  const body = await readFile(join(source, file), 'utf8')
  return HEADER + body
}

async function syncTarget(target, files) {
  const drift = []
  const existing = existsSync(target.dir) ? (await readdir(target.dir)).filter((f) => f.endsWith('.ts')) : []

  for (const file of files) {
    const want = await expected(file)
    const path = join(target.dir, file)
    const have = existsSync(path) ? await readFile(path, 'utf8') : null
    if (have !== want) drift.push(file)
  }
  const stale = existing.filter((f) => !files.includes(f))

  if (checkOnly) return { drift, stale }

  await mkdir(target.dir, { recursive: true })
  for (const file of drift) await writeFile(join(target.dir, file), await expected(file), 'utf8')
  for (const file of stale) await unlink(join(target.dir, file))
  return { drift, stale }
}

async function main() {
  const files = await listSource()
  let failed = false

  for (const target of targets) {
    if (!existsSync(join(parent, target.name === 'lumia' ? 'lumia' : 'lumia2.0'))) {
      console.error(`[${target.name}] proyecto no encontrado; se omite`)
      failed = true
      continue
    }
    const { drift, stale } = await syncTarget(target, files)
    const label = checkOnly ? 'desviados' : 'actualizados'
    console.log(`[${target.name}] ${label}: ${drift.length} · obsoletos: ${stale.length}${drift.length ? ' → ' + drift.join(', ') : ''}`)
    if (checkOnly && (drift.length || stale.length)) failed = true
  }

  if (checkOnly && failed) {
    console.error('Los contratos no están sincronizados. Ejecuta: node scripts/sync-contracts.mjs')
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

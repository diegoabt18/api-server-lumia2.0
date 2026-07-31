import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { config as dotenvConfig } from 'dotenv'

let loaded = false

/** Carga `.env.{NODE_ENV}` (development | production). */
export function loadDotenvConfig(): void {
  if (loaded) return

  const cwd = process.cwd()
  const nodeEnv = process.env.NODE_ENV ?? 'development'
  const filePath = resolve(cwd, `.env.${nodeEnv}`)

  if (existsSync(filePath)) {
    dotenvConfig({ path: filePath })
  }

  loaded = true
}

/** Reinicia el estado (solo tests). */
export function resetDotenvConfigForTests(): void {
  loaded = false
}

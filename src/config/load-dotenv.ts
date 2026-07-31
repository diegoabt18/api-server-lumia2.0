import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { config as dotenvConfig } from 'dotenv'

let loaded = false

/**
 * Carga variables de entorno en orden (Twelve-Factor):
 * 1. .env
 * 2. .env.{NODE_ENV}  (ej. .env.development, .env.production)
 * 3. .env.local
 * 4. .env.{NODE_ENV}.local
 */
export function loadDotenvConfig(): void {
  if (loaded) return

  const cwd = process.cwd()
  const nodeEnv = process.env.NODE_ENV ?? 'development'

  const files = ['.env', `.env.${nodeEnv}`, '.env.local', `.env.${nodeEnv}.local`]

  for (const file of files) {
    const filePath = resolve(cwd, file)
    if (existsSync(filePath)) {
      dotenvConfig({ path: filePath, override: true })
    }
  }

  loaded = true
}

/** Reinicia el estado (solo tests). */
export function resetDotenvConfigForTests(): void {
  loaded = false
}

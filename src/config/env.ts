import { z } from 'zod'
import { loadDotenvConfig } from './load-dotenv.js'

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  APP_NAME: z.string().default('lumia-api'),
  APP_URL: z.string().url().default('https://api.lumiadalistore.com'),
  FRONTEND_URL: z.string().url().default('https://lumiadalistore.com'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().default(3001),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // MongoDB — 4 bases separadas (misma convención que lumia)
  MONGO_AUTH_URI: z.string().min(1),
  MONGO_CATALOG_URI: z.string().min(1),
  MONGO_SALES_URI: z.string().min(1),
  MONGO_PRODUCTION_URI: z.string().min(1),

  // Redis
  REDIS_URL: z.string().optional(),
  REDIS_ENABLED: z
    .string()
    .transform((v) => v === 'true')
    .default('true'),

  // JWT
  JWT_SECRET: z.string().min(16),
  JWT_ACCESS_EXPIRES_IN: z.string().default('10m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
  JWT_REFRESH_REMEMBER_EXPIRES_IN: z.string().default('30d'),

  // Cookies (compatibles con frontend lumia existente)
  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_ACCESS_NAME: z.string().default('lumia_access'),
  COOKIE_REFRESH_NAME: z.string().default('lumia_refresh'),
  COOKIE_SECURE: z
    .string()
    .transform((v) => v === 'true')
    .optional(),

  // CORS
  CORS_ORIGINS: z.string().default('https://lumiadalistore.com,https://www.lumiadalistore.com'),

  // Rate limit
  RATE_LIMIT_MAX: z.coerce.number().default(100),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60000),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().default(10),

  // Store
  ORDER_NUMBER_PREFIX: z.string().default('ORD'),
  STORE_BESTSELLER_TOP_N: z.coerce.number().default(8),
  STORE_POPULAR_MIN_UNITS: z.coerce.number().default(3),

  // Auth providers
  AUTH_LOCAL_ENABLED: z
    .string()
    .transform((v) => v === 'true')
    .default('true'),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  // MercadoPago (fase futura)
  MP_ACCESS_TOKEN: z.string().optional(),
  MP_WEBHOOK_SECRET: z.string().optional(),

  // Orders / payments TTL (horas)
  ORDER_PAYMENT_TTL_HOURS: z.coerce.number().default(24),
  ORDER_MANUAL_PAYMENT_TTL_HOURS: z.coerce.number().default(72),

  // Seeds
  DB_SEED_DISABLED: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),
  DB_SEED_FORCE: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),

  // Uploads / logs
  UPLOADS_DIR: z.string().default('./uploads'),
  LOGS_DIR: z.string().default('./logs'),

  // 2FA
  TWO_FACTOR_ENCRYPTION_KEY: z.string().optional(),
})

export type Env = z.infer<typeof envSchema>

let cached: Env | null = null

export function loadEnv(overrides?: Record<string, string>): Env {
  if (cached && !overrides) return cached

  loadDotenvConfig()

  const parsed = envSchema.safeParse({ ...process.env, ...overrides })
  if (!parsed.success) {
    const formatted = parsed.error.flatten().fieldErrors
    throw new Error(`Invalid environment configuration: ${JSON.stringify(formatted)}`)
  }

  cached = parsed.data
  return parsed.data
}

export function getEnv(): Env {
  if (!cached) return loadEnv()
  return cached
}

export function getCorsOrigins(env: Env): string[] {
  const origins = env.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean)

  if (env.NODE_ENV === 'development') {
    origins.push(
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://localhost:3002',
      'http://127.0.0.1:3002',
    )
  }

  return [...new Set(origins)]
}

export function isCookieSecure(env: Env): boolean {
  if (env.COOKIE_SECURE !== undefined) return env.COOKIE_SECURE
  return env.NODE_ENV === 'production'
}

/** Nombres lógicos de las 4 bases MongoDB (alineados con lumia). */
export const MONGO_DB_NAMES = {
  identity: 'identity_db',
  catalog: 'catalog_db',
  sales: 'sales_db',
  production: 'production_db',
} as const

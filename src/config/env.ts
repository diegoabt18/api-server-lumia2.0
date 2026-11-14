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
  /** Contraseñas fallidas por cuenta (email) antes de bloquear el login durante la ventana. */
  LOGIN_MAX_FAILURES: z.coerce.number().int().min(3).default(10),
  /** Códigos 2FA fallidos por usuario antes de bloquear la verificación durante la ventana. */
  TWO_FACTOR_MAX_FAILURES: z.coerce.number().int().min(3).default(5),
  LOGIN_LOCK_WINDOW_SECONDS: z.coerce.number().int().min(60).default(900),
  /**
   * Proxies de confianza para calcular la IP del cliente (opción trustProxy de Fastify):
   * 'true', 'false', un número de saltos o una lista de IP/CIDR/nombres de proxy-addr separados
   * por coma. Por defecto loopback y redes privadas (cloudflared en el host y red Docker). Con
   * 'true' la IP sale del X-Forwarded-For más a la izquierda y el cliente puede falsearla.
   */
  TRUST_PROXY: z.string().default('loopback,uniquelocal'),
  /**
   * Secreto compartido con los proxies propios (BFF de Lumia Admin y Worker de Lumia 2.0). Con él,
   * la cabecera X-Lumia-Client-IP se acepta como IP real del cliente. Mínimo 32 caracteres.
   */
  EDGE_PROXY_SECRET: z.string().min(32).optional(),
  /**
   * Clave HMAC de la cadena de auditoría administrativa. Sin ella se deriva de JWT_SECRET (rotar
   * JWT_SECRET invalidaría la verificación de los registros anteriores). Mínimo 32 caracteres.
   */
  ADMIN_AUDIT_SIGNING_KEY: z.string().min(32).optional(),
  /** Swagger UI en /docs. Sin valor: activo fuera de producción, desactivado en producción. */
  SWAGGER_ENABLED: z
    .string()
    .transform((v) => v === 'true')
    .optional(),

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

  // MercadoPago (preparado, desactivado). Las credenciales NO activan la integración.
  MERCADOPAGO_ENABLED: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),
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

  // Email (notificaciones internas — p. ej. pre-venta a ventas@)
  EMAIL_ENABLED: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_SECURE: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().default('notificaciones@lumiadalistore.com'),
  SALES_NOTIFY_EMAIL: z.string().email().default('ventas@lumiadalistore.com'),

  // FCM push (LumiChat — notificaciones de nuevos pedidos)
  FCM_ENABLED: z
    .string()
    .transform((v) => v === 'true')
    .default('false'),
  FCM_PROJECT_ID: z.string().optional(),
  FCM_CLIENT_EMAIL: z.string().optional(),
  /** Clave privada del service account (PEM). En .env usar \\n para saltos de línea. */
  FCM_PRIVATE_KEY: z.string().optional(),
  /** Clave compartida app ↔ API para registrar tokens FCM */
  LUMICHAT_DEVICE_KEY: z.string().min(16).optional(),

  // Asistente Lumi (ia-asistente). Sin URL, las rutas /admin/lumi responden 503.
  LUMI_ASSISTANT_URL: z.string().url().optional(),
  /** Clave de servicio servidor ↔ ia-asistente (X-API-Key). Nunca se expone al navegador. */
  LUMI_ASSISTANT_API_KEY: z.string().min(16).optional(),
  LUMI_ASSISTANT_TIMEOUT_MS: z.coerce.number().int().min(1000).default(120000),

  // Motor de automatización de Lumi (scheduler + worker). Sin Qwen en la Fase 1.
  LUMI_AUTOMATION_ENABLED: z
    .string()
    .transform((v) => v === 'true')
    .default('true'),
  LUMI_AUTOMATION_TICK_MS: z.coerce.number().int().min(5000).default(30000),
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

export type TrustProxySetting = boolean | string[] | ((address: string, hop: number) => boolean)

/**
 * Convierte TRUST_PROXY en el valor que espera Fastify: boolean, lista de IP/CIDR o, para un número
 * de saltos N, la función equivalente de proxy-addr (se confía en los N saltos más cercanos).
 */
export function parseTrustProxy(value: string): TrustProxySetting {
  const v = value.trim().toLowerCase()
  if (v === '' || v === 'true') return true
  if (v === 'false') return false
  if (/^\d+$/.test(v)) {
    const hops = Number(v)
    return (_address: string, hop: number) => hop < hops
  }
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
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

import { createHmac } from 'node:crypto'

/**
 * Auditoría de la actividad administrativa: tipos y funciones puras (saneado, diferencias, hash).
 */

export type ActivityResult = 'success' | 'denied' | 'failure'

export interface ActivityActor {
  userId: string | null
  ip: string | null
  userAgent: string | null
}

export interface ActivityResource {
  type: string
  id: string | null
}

export interface ActivityChange {
  before: unknown
  after: unknown
}

/** Registro tal como se guarda (sin _id). `hash` encadena con el registro anterior. */
export interface ActivityRecord {
  seq: number
  at: Date
  actor: ActivityActor
  /** Operación: método y patrón de ruta, p. ej. "PATCH /api/admin/products/:id". */
  action: string
  resource: ActivityResource
  /** Cuerpo saneado de la petición (sin secretos, recortado). */
  input: unknown
  /** Solo los campos que cambiaron, cuando el recurso tiene instantánea antes/después. */
  changes: Record<string, ActivityChange> | null
  result: ActivityResult
  statusCode: number
  errorCode: string | null
  requestId: string
  prevHash: string
  hash: string
}

export const GENESIS_HASH = '0'.repeat(64)
export const REDACTED = '[REDACTED]'

/** Claves que nunca se guardan (comparación sin mayúsculas ni separadores). */
const SECRET_KEYS = new Set([
  'password',
  'passwordhash',
  'currentpassword',
  'newpassword',
  'token',
  'accesstoken',
  'refreshtoken',
  'temptoken',
  'idtoken',
  'secret',
  'secretencrypted',
  'clientsecret',
  'webhooksecret',
  'apikey',
  'privatekey',
  'backupcodes',
  'authorization',
  'cookie',
  'otp',
  'totp',
  'code2fa',
  'fcmtoken',
  'accountnumber',
])

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '')
}

export function isSecretKey(key: string, opts: { twoFactorRoute?: boolean } = {}): boolean {
  const k = normalizeKey(key)
  if (SECRET_KEYS.has(k)) return true
  if (k.endsWith('password') || k.endsWith('token') || k.endsWith('secret')) return true
  // En rutas de 2FA el campo `code` es un código de un solo uso.
  return Boolean(opts.twoFactorRoute) && k === 'code'
}

const MAX_DEPTH = 6
const MAX_STRING = 1000
const MAX_ARRAY = 50
const MAX_KEYS = 80

/** Copia acotada y sin secretos de un valor JSON. */
export function sanitize(value: unknown, opts: { twoFactorRoute?: boolean } = {}, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[+${value.length - MAX_STRING}]` : value
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (value instanceof Date) return value.toISOString()
  if (depth >= MAX_DEPTH) return '[TRUNCATED]'
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY).map((v) => sanitize(v, opts, depth + 1))
    if (value.length > MAX_ARRAY) items.push(`[+${value.length - MAX_ARRAY} más]`)
    return items
  }
  if (typeof value === 'object') {
    if (typeof (value as { toHexString?: unknown }).toHexString === 'function') {
      return (value as { toHexString(): string }).toHexString()
    }
    const out: Record<string, unknown> = {}
    const entries = Object.entries(value as Record<string, unknown>)
    for (const [key, v] of entries.slice(0, MAX_KEYS)) {
      out[key] = isSecretKey(key, opts) ? REDACTED : sanitize(v, opts, depth + 1)
    }
    if (entries.length > MAX_KEYS) out['…'] = `[+${entries.length - MAX_KEYS} campos]`
    return out
  }
  return String(value)
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  const keys = Object.keys(value as Record<string, unknown>).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`).join(',')}}`
}

/** Campos de primer nivel que cambiaron entre dos instantáneas ya saneadas. */
export function diffSnapshots(before: unknown, after: unknown): Record<string, ActivityChange> | null {
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  if (!isObj(before) && !isObj(after)) {
    return stable(before) === stable(after) ? null : { value: { before: before ?? null, after: after ?? null } }
  }
  const b = isObj(before) ? before : {}
  const a = isObj(after) ? after : {}
  const changes: Record<string, ActivityChange> = {}
  for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (key === 'updatedAt' || key === 'version') continue
    if (stable(b[key]) !== stable(a[key])) {
      changes[key] = { before: b[key] ?? null, after: a[key] ?? null }
    }
  }
  return Object.keys(changes).length ? changes : null
}

/** Contenido que firma el hash: todo el registro salvo el propio hash. */
export function canonicalRecord(record: Omit<ActivityRecord, 'hash'>): string {
  return stable({ ...record, at: record.at.toISOString() })
}

/** HMAC-SHA256 encadenado: sin la clave no se puede rehacer la cadena tras alterar un registro. */
export function computeHash(key: string, record: Omit<ActivityRecord, 'hash'>): string {
  return createHmac('sha256', key).update(record.prevHash).update('\n').update(canonicalRecord(record)).digest('hex')
}

export interface ChainCheck {
  ok: boolean
  checked: number
  /** Primer número de secuencia con problema (hash alterado, hueco o enlace roto). */
  brokenAtSeq: number | null
  reason: string | null
}

/** Verifica una secuencia ordenada por `seq` que empieza en `expectedPrev`/`expectedSeq`. */
export function verifyChain(
  key: string,
  records: ActivityRecord[],
  expectedPrev = GENESIS_HASH,
  expectedSeq = 1,
): ChainCheck {
  let prev = expectedPrev
  let seq = expectedSeq
  for (const record of records) {
    const { hash, ...rest } = record
    if (record.seq !== seq) return { ok: false, checked: seq - expectedSeq, brokenAtSeq: seq, reason: 'Falta un registro (hueco en la secuencia)' }
    if (record.prevHash !== prev) return { ok: false, checked: seq - expectedSeq, brokenAtSeq: seq, reason: 'Enlace con el registro anterior roto' }
    if (computeHash(key, rest) !== hash) return { ok: false, checked: seq - expectedSeq, brokenAtSeq: seq, reason: 'Contenido alterado' }
    prev = hash
    seq += 1
  }
  return { ok: true, checked: records.length, brokenAtSeq: null, reason: null }
}

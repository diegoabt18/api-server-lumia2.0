import { createHash, randomBytes, randomUUID } from 'node:crypto'

export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Identificador de dispositivo de una sesión. Un nuevo login revoca las sesiones del mismo usuario
 * en el mismo dispositivo. `clientApp` separa aplicaciones (tienda y Lumia Admin) que comparten
 * navegador: sin él, entrar en el admin cerraba la sesión de la tienda y al revés.
 */
export function buildDeviceId(
  userAgent?: string,
  extras?: { acceptLanguage?: string; clientApp?: string },
): string {
  const raw = [userAgent ?? '', extras?.acceptLanguage ?? '', ...(extras?.clientApp ? [extras.clientApp] : [])].join('|')
  return createHash('sha256').update(raw).digest('hex').slice(0, 32)
}

export function parseUserAgent(ua?: string): {
  deviceName: string
  browser: string
  os: string
  deviceType: 'desktop' | 'mobile' | 'tablet' | 'unknown'
} {
  const s = ua ?? ''
  const isMobile = /mobile|android|iphone/i.test(s)
  const isTablet = /ipad|tablet/i.test(s)
  let browser = 'Unknown'
  if (/chrome/i.test(s) && !/edge/i.test(s)) browser = 'Chrome'
  else if (/firefox/i.test(s)) browser = 'Firefox'
  else if (/safari/i.test(s) && !/chrome/i.test(s)) browser = 'Safari'
  else if (/edge/i.test(s)) browser = 'Edge'

  let os = 'Unknown'
  if (/windows/i.test(s)) os = 'Windows'
  else if (/mac os/i.test(s)) os = 'macOS'
  else if (/android/i.test(s)) os = 'Android'
  else if (/iphone|ipad/i.test(s)) os = 'iOS'
  else if (/linux/i.test(s)) os = 'Linux'

  const deviceType = isTablet ? 'tablet' : isMobile ? 'mobile' : 'desktop'
  const deviceName = `${browser} on ${os}`

  return { deviceName, browser, os, deviceType }
}

export function newTokenFamilyId(): string {
  return randomUUID()
}

export function parseDurationMs(input: string, fallbackMs: number): number {
  const match = /^(\d+)([smhd])$/.exec(input.trim())
  if (!match) return fallbackMs
  const n = Number(match[1])
  const unit = match[2]
  const multipliers: Record<string, number> = { s: 1000, m: 60000, h: 3600000, d: 86400000 }
  return n * (multipliers[unit] ?? 1000)
}

import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto'
import { z } from 'zod'
import type { CapabilityReport } from './protocol.js'

/**
 * Equipos de escritorio registrados (Lumia Desktop Agent). Cada equipo tiene su propio par Ed25519:
 * no hay clave compartida en el instalador. El alta exige un código de inscripción de un solo uso
 * que genera en Lumia Admin quien tiene desktop.devices.manage; esa persona es la propietaria.
 */

export type DeviceStatus = 'active' | 'revoked'
export type DeviceExecutionState = 'active' | 'paused'

export interface DesktopDevice {
  id: string
  ownerUserId: string
  installationId: string
  /** Clave pública Ed25519 en base64url (32 bytes, sin relleno). */
  publicKey: string
  name: string
  os: DeviceOs
  osVersion: string
  arch: string
  agentVersion: string
  status: DeviceStatus
  /** Lo último que informó el agente: si el usuario pausó la ejecución en el equipo. */
  execution: DeviceExecutionState
  capabilities: CapabilityReport | null
  registeredAt: Date
  revokedAt: Date | null
  lastSeenAt: Date | null
}

export const DEVICE_OS = ['windows', 'macos', 'linux'] as const
export type DeviceOs = (typeof DEVICE_OS)[number]

const deviceNameSchema = z.string().trim().min(1).max(64)

export const deviceInfoSchema = z.object({
  name: deviceNameSchema,
  os: z.enum(DEVICE_OS),
  os_version: z.string().trim().min(1).max(64),
  arch: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .regex(/^[A-Za-z0-9_.-]+$/),
  agent_version: z.string().trim().min(1).max(32),
})

const base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/)

export const registrationStartSchema = z.object({
  enrollment_code: z.string().trim().min(8).max(32),
  installation_id: z.string().uuid(),
  public_key: base64Url.length(43),
  device_info: deviceInfoSchema,
})

export const registrationCompleteSchema = z.object({
  registration_id: z.string().uuid(),
  signature: base64Url.length(86),
})

export const renameDeviceSchema = z.object({ name: deviceNameSchema })
export const deviceIdParamsSchema = z.object({ id: z.string().regex(/^dev_[a-f0-9]{24}$/) })

/** Código legible: sin 0/O, 1/I/L ni U para dictarlo sin errores. 10 símbolos ≈ 50 bits. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'
export const ENROLLMENT_CODE_LENGTH = 10
export const ENROLLMENT_TTL_MS = 10 * 60_000
export const REGISTRATION_CHALLENGE_TTL_MS = 60_000

export function generateEnrollmentCode(): string {
  const bytes = randomBytes(ENROLLMENT_CODE_LENGTH * 2)
  let code = ''
  // Rechazo por módulo: solo se usan bytes por debajo del mayor múltiplo del alfabeto (sin sesgo).
  const limit = 256 - (256 % CODE_ALPHABET.length)
  for (const byte of bytes) {
    if (byte >= limit) continue
    code += CODE_ALPHABET[byte % CODE_ALPHABET.length]
    if (code.length === ENROLLMENT_CODE_LENGTH) break
  }
  return code.length === ENROLLMENT_CODE_LENGTH
    ? `${code.slice(0, 5)}-${code.slice(5)}`
    : generateEnrollmentCode()
}

/** Normaliza lo que escribe la persona (minúsculas, guiones, espacios) antes de compararlo. */
export function normalizeEnrollmentCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/** Solo se guarda el hash: una copia de la base de datos no permite inscribir equipos. */
export function hashEnrollmentCode(raw: string): string {
  return createHash('sha256').update(normalizeEnrollmentCode(raw)).digest('hex')
}

export function newDeviceId(): string {
  return `dev_${randomBytes(12).toString('hex')}`
}

export function newNonce(): string {
  return randomBytes(32).toString('base64url')
}

export function newId(): string {
  return randomUUID()
}

/**
 * Verifica una firma Ed25519. La clave y la firma llegan en base64url; cualquier error de formato
 * cuenta como firma inválida.
 */
export function verifyEd25519(publicKey: string, message: string, signature: string): boolean {
  try {
    const raw = Buffer.from(publicKey, 'base64url')
    const sig = Buffer.from(signature, 'base64url')
    if (raw.length !== 32 || sig.length !== 64) return false
    const key = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: publicKey },
      format: 'jwk',
    })
    return verify(null, Buffer.from(message, 'utf8'), key, sig)
  } catch {
    return false
  }
}

/** Vista para Lumia Admin: sin clave pública ni identificador de instalación. */
export function toDeviceView(device: DesktopDevice, online: boolean) {
  return {
    id: device.id,
    name: device.name,
    os: device.os,
    osVersion: device.osVersion,
    arch: device.arch,
    agentVersion: device.agentVersion,
    status: device.status,
    execution: device.execution,
    online: device.status === 'active' && online,
    capabilities: device.capabilities,
    registeredAt: device.registeredAt.toISOString(),
    revokedAt: device.revokedAt?.toISOString() ?? null,
    lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
  }
}
export type DesktopDeviceView = ReturnType<typeof toDeviceView>

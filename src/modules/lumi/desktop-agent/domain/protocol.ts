import { z } from 'zod'

/**
 * Protocolo WebSocket entre Lumia Server y Lumia Desktop Agent (versión 1.1).
 * Contrato documentado en lumia-desktop-agent/docs/communication-protocol.md: cualquier cambio aquí
 * debe reflejarse allí y en el crate `agent-protocol`.
 *
 * 1.0 (fase 1): sesión, latido, estado y capacidades.
 * 1.1 (fase 2, aditiva): grants firmados por el Server y ciclo de vida de tareas (task.*).
 */

export const PROTOCOL_MAJOR = 1
export const PROTOCOL_VERSION = '1.2'
/** Prefijo de dominio de todas las cadenas firmadas: una firma de registro nunca vale para autenticar. */
export const SIGNING_DOMAIN = 'lumia-desktop-agent/v1'

export const HEARTBEAT_INTERVAL_MS = 25_000
/** Sin ningún mensaje del agente durante este tiempo, la conexión se da por muerta. */
export const HEARTBEAT_TIMEOUT_MS = 3 * HEARTBEAT_INTERVAL_MS
export const AUTH_TIMEOUT_MS = 10_000
/** Un resultado de snapshot (hasta 60 000 caracteres más referencias) cabe holgadamente. */
export const MAX_MESSAGE_BYTES = 512 * 1024

/** Códigos de cierre del WebSocket (rango 4000-4999 reservado a la aplicación). */
export const CLOSE_CODES = {
  malformed: 4400,
  unauthenticated: 4401,
  revoked: 4403,
  heartbeatTimeout: 4408,
  replaced: 4409,
  protocolUnsupported: 4426,
  rateLimited: 4429,
  shuttingDown: 4503,
} as const

export type SessionErrorCode =
  | 'MALFORMED_MESSAGE'
  | 'UNEXPECTED_MESSAGE'
  | 'PROTOCOL_UNSUPPORTED'
  | 'AUTHENTICATION_FAILED'
  | 'AUTHENTICATION_TIMEOUT'
  | 'DEVICE_REVOKED'
  | 'RATE_LIMITED'
  | 'OPERATION_NOT_AVAILABLE'

const id = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/)

export const envelopeSchema = z.object({
  protocol_version: z.string().regex(/^\d+\.\d+$/),
  message_id: id,
  message_type: z.string().min(1).max(64),
  timestamp: z.string().datetime({ offset: true }),
  device_id: id.nullable(),
  task_id: id.nullable(),
  correlation_id: id.nullable().optional(),
  payload: z.record(z.unknown()),
})
export type Envelope = z.infer<typeof envelopeSchema>

export const helloPayloadSchema = z.object({
  agent_version: z.string().min(1).max(32),
  protocol_versions: z
    .array(z.string().regex(/^\d+\.\d+$/))
    .min(1)
    .max(8),
})

export const authenticatePayloadSchema = z.object({
  signature: z.string().min(1).max(128),
})

export const deviceStatusPayloadSchema = z.object({
  /** `paused`: el usuario detuvo la ejecución desde la interfaz local. Solo restringe. */
  execution: z.enum(['active', 'paused']),
})

const engineStatusSchema = z.object({
  available: z.boolean(),
  /** Motivo legible cuando no está disponible (p. ej. "not_integrated", "permission_missing"). */
  reason: z.string().max(120).nullable(),
})

export const capabilityReportPayloadSchema = z.object({
  engines: z.object({
    browser: engineStatusSchema,
    desktop: engineStatusSchema,
  }),
  /** Operaciones que el agente tiene registradas (fase 1: ninguna). */
  operations: z.array(z.string().max(64)).max(64),
})
export type CapabilityReport = z.infer<typeof capabilityReportPayloadSchema>

/** ¿Habla el agente alguna versión con nuestra mayor? Devuelve la versión negociada o null. */
export function negotiateVersion(offered: readonly string[]): string | null {
  return offered.some((v) => Number(v.split('.')[0]) === PROTOCOL_MAJOR) ? PROTOCOL_VERSION : null
}

// ---------------------------------------------------------------------------------------------
// Tareas (1.1)
// ---------------------------------------------------------------------------------------------

export const TASK_STATES = ['received', 'validated', 'running', 'verifying'] as const
export type TaskState = (typeof TASK_STATES)[number]

export const TASK_OUTCOMES = ['completed', 'unverified', 'failed', 'rejected', 'cancelled'] as const
export type TaskOutcome = (typeof TASK_OUTCOMES)[number]

export const taskStatePayloadSchema = z.object({ state: z.enum(TASK_STATES) })

const taskErrorSchema = z.object({
  code: z.string().min(1).max(64),
  message: z.string().max(400),
  retryable: z.boolean(),
})
export type TaskError = z.infer<typeof taskErrorSchema>

export const taskResultPayloadSchema = z.object({
  status: z.enum(TASK_OUTCOMES),
  operation: z.string().max(64),
  verification: z.object({ verified: z.boolean(), method: z.string().max(64) }).nullable(),
  result: z.unknown().nullable(),
  error: taskErrorSchema.nullable(),
  duration_ms: z.number().int().min(0),
})
export type TaskResultPayload = z.infer<typeof taskResultPayloadSchema>

// ---------------------------------------------------------------------------------------------
// Transferencias (1.2): datos de una tarea `files.download` / `files.upload` en curso. El grant de
// la tarea es lo que autoriza la transferencia. Bloques de 256 KiB como máximo (base64).
// ---------------------------------------------------------------------------------------------

/** Mensajes de transferencia que puede enviar un agente. */
export const AGENT_TRANSFER_MESSAGES = ['transfer.open', 'transfer.data', 'transfer.ack'] as const

const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/)

export const transferOpenPayloadSchema = z.object({
  name: z.string().min(1).max(255),
  size: z
    .number()
    .int()
    .min(0)
    .max(100 * 1024 * 1024),
  sha256: sha256Hex,
})
export type TransferOpenPayload = z.infer<typeof transferOpenPayloadSchema>

export const transferDataPayloadSchema = z.object({
  offset: z.number().int().min(0),
  // 256 KiB en base64 son 349 528 caracteres.
  data: z.string().max(349_528),
  eof: z.boolean(),
})

export const transferAckPayloadSchema = z.object({
  offset: z.number().int().min(0),
  length: z
    .number()
    .int()
    .min(1)
    .max(256 * 1024),
})

export function registrationSigningString(
  challenge: string,
  installationId: string,
  publicKey: string,
): string {
  return `${SIGNING_DOMAIN}|register|${challenge}|${installationId}|${publicKey}`
}

export function authSigningString(nonce: string, deviceId: string, connectionId: string): string {
  return `${SIGNING_DOMAIN}|auth|${nonce}|${deviceId}|${connectionId}`
}

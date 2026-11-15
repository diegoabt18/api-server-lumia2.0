import { z } from 'zod'
import { LUMI_MODULES } from '../../tools/tool.types.js'

/**
 * Capability Manager de Lumi (fase B): lo que los usuarios piden y ninguna herramienta hace.
 * El Server registra la petición; un administrador la revisa. Nada de aquí habilita herramientas:
 * los estados de prueba y activación (testing → enabled) llegan en las fases D y E y los pone el
 * propio Server tras validar, nunca una transición manual.
 */

export const CAPABILITY_STATUSES = [
  'detected',
  'pending_review',
  'approved',
  'in_development',
  'ready_for_testing',
  'testing',
  'failed',
  'validated',
  'enabled',
  'disabled',
  'rejected',
  'duplicate',
] as const
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number]

/**
 * Transiciones que un administrador puede pedir a mano. `duplicate` solo llega por fusión, y de
 * `ready_for_testing` en adelante solo el Server (batería de pruebas y activación validada).
 */
export const MANUAL_TRANSITIONS: Readonly<Partial<Record<CapabilityStatus, readonly CapabilityStatus[]>>> = {
  detected: ['pending_review', 'rejected'],
  pending_review: ['approved', 'rejected', 'detected'],
  approved: ['in_development', 'rejected', 'pending_review'],
  in_development: ['ready_for_testing', 'approved'],
  ready_for_testing: ['in_development'],
  rejected: ['pending_review'],
}

export function canTransition(from: CapabilityStatus, to: CapabilityStatus): boolean {
  return (MANUAL_TRANSITIONS[from] ?? []).includes(to)
}


export const CAPABILITY_PRIORITIES = ['low', 'normal', 'high'] as const
export type CapabilityPriority = (typeof CAPABILITY_PRIORITIES)[number]

/** Módulo de la tienda al que pertenece; `none` si el modelo no lo supo ubicar. */
export const CAPABILITY_MODULES = [...LUMI_MODULES, 'none'] as const
export type CapabilityModule = (typeof CAPABILITY_MODULES)[number]

export function capabilityModule(value: string): CapabilityModule {
  return (CAPABILITY_MODULES as readonly string[]).includes(value) ? (value as CapabilityModule) : 'none'
}

export const MESSAGE_MAX_CHARS = 500
export const NEED_MAX_CHARS = 120
export const SAMPLE_LIMIT = 5
export const HISTORY_LIMIT = 50
/** Una misma persona repitiendo la misma petición no la cuenta dos veces en este intervalo. */
export const REPEAT_WINDOW_MS = 10 * 60_000

/** Especificación que el administrador completa para quien programe la herramienta. */
export const capabilitySpecSchema = z
  .object({
    expectedResult: z.string().trim().max(1000),
    parameters: z.string().trim().max(1000),
    rules: z.string().trim().max(1000),
    proposedPermission: z.string().trim().max(100),
    dataSource: z.string().trim().max(300),
    relatedTool: z.string().trim().max(100),
    notes: z.string().trim().max(2000),
  })
  .strict()
export type CapabilitySpec = z.infer<typeof capabilitySpecSchema>

export const EMPTY_SPEC: CapabilitySpec = {
  expectedResult: '',
  parameters: '',
  rules: '',
  proposedPermission: '',
  dataSource: '',
  relatedTool: '',
  notes: '',
}

export interface CapabilityHistoryEntry {
  at: Date
  /** userId del administrador, o `system` para el registro automático. */
  by: string
  action: 'created' | 'updated' | 'status' | 'merged_from' | 'merged_into' | 'tested' | 'implemented'
  from?: string
  to?: string
}

/** Resumen de la última batería de pruebas (fase D). */
export interface CapabilityLastTest {
  runId: string
  at: Date
  passed: boolean | null
  /** Acierto en las frases de validación (0–1), o null si no hay. */
  validationAccuracy: number | null
}

export interface LumiCapability {
  id: string
  key: string
  title: string
  description: string
  module: CapabilityModule
  status: CapabilityStatus
  priority: CapabilityPriority
  signature: string
  keywords: string[]
  requestCount: number
  /** Últimas frases tal como se pidieron (máx. SAMPLE_LIMIT), sin autor. */
  samples: string[]
  spec: CapabilitySpec
  mergedInto: string | null
  /** Coincidencia dudosa: la decisión de fusionar es del administrador. */
  possibleDuplicateOf: string | null
  /**
   * Herramienta del registro del Server que la implementa (fase E). La pone la sincronización al
   * arrancar cuando una herramienta declara este `key` como su `capabilityKey`; nunca un usuario.
   */
  toolName: string | null
  history: CapabilityHistoryEntry[]
  lastTest: CapabilityLastTest | null
  firstSeenAt: Date
  lastSeenAt: Date
  createdAt: Date
  updatedAt: Date
}

export interface CapabilityRequest {
  id: string
  capabilityId: string
  userId: string
  conversationId: string | null
  message: string
  need: string
  module: CapabilityModule
  signature: string
  createdAt: Date
}

/* ───────────── Entrada de las rutas de administración ───────────── */

export const capabilityIdParamsSchema = z.object({ id: z.string().regex(/^[a-f0-9]{24}$/) })

export const listCapabilitiesQuerySchema = z.object({
  status: z.enum(CAPABILITY_STATUSES).optional(),
  module: z.enum(CAPABILITY_MODULES).optional(),
  priority: z.enum(CAPABILITY_PRIORITIES).optional(),
  search: z.string().trim().max(100).optional(),
  sort: z.enum(['recent', 'requests', 'created']).default('recent'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})
export type ListCapabilitiesQuery = z.infer<typeof listCapabilitiesQuerySchema>

export const updateCapabilitySchema = z
  .object({
    title: z.string().trim().min(3).max(120),
    description: z.string().trim().max(2000),
    module: z.enum(CAPABILITY_MODULES),
    priority: z.enum(CAPABILITY_PRIORITIES),
    spec: capabilitySpecSchema.partial(),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update')
export type UpdateCapabilityInput = z.infer<typeof updateCapabilitySchema>

export const changeCapabilityStatusSchema = z.object({ status: z.enum(CAPABILITY_STATUSES) }).strict()

export const mergeCapabilitySchema = z.object({ targetId: z.string().regex(/^[a-f0-9]{24}$/) }).strict()

/** Habilitar exige confirmar que la capacidad está documentada (fase E). */
export const enableCapabilitySchema = z.object({ documented: z.literal(true) }).strict()

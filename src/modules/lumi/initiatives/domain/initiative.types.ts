import { z } from 'zod'

/**
 * Iniciativas de Lumi (Fase 4): propuestas de atención que el motor detecta por reglas. Lumi no ejecuta
 * acciones sobre la tienda: solo propone y la persona decide el estado.
 */

export const INITIATIVE_KINDS = ['stock', 'order_attention', 'routine_failed'] as const
export type InitiativeKind = (typeof INITIATIVE_KINDS)[number]

export const INITIATIVE_STATES = [
  'nueva',
  'pendiente',
  'en_revision',
  'aceptada',
  'rechazada',
  'completada',
  'descartada',
] as const
export type InitiativeState = (typeof INITIATIVE_STATES)[number]

/** Estados que siguen vigentes mientras la condición detectada persista. */
export const OPEN_INITIATIVE_STATES: readonly InitiativeState[] = ['nueva', 'pendiente', 'en_revision', 'aceptada']

export const INITIATIVE_LEVELS = ['discreta', 'equilibrada', 'proactiva'] as const
export type InitiativeLevel = (typeof INITIATIVE_LEVELS)[number]
export const DEFAULT_INITIATIVE_LEVEL: InitiativeLevel = 'equilibrada'

/** 1 = informativa, 2 = conviene revisar, 3 = urgente. */
export type InitiativePriority = 1 | 2 | 3

export interface LumiInitiative {
  id: string
  userId: string
  kind: InitiativeKind
  subjectKey: string
  dedupKey: string
  title: string
  detail: string
  priority: InitiativePriority
  state: InitiativeState
  /** Cuántas veces se ha abierto esta iniciativa (se reabre si la condición vuelve tras resolverse). */
  openCount: number
  firstSeenAt: Date
  lastSeenAt: Date
  stateChangedAt: Date
  resolvedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

/** Transiciones que la persona puede pedir. El motor usa sus propias reglas (ver initiative.rules). */
const USER_TRANSITIONS: Record<InitiativeState, readonly InitiativeState[]> = {
  nueva: ['pendiente', 'en_revision', 'aceptada', 'rechazada', 'completada', 'descartada'],
  pendiente: ['en_revision', 'aceptada', 'rechazada', 'completada', 'descartada'],
  en_revision: ['pendiente', 'aceptada', 'rechazada', 'completada', 'descartada'],
  aceptada: ['completada', 'descartada'],
  rechazada: [],
  completada: [],
  descartada: [],
}

export function canTransition(from: InitiativeState, to: InitiativeState): boolean {
  return USER_TRANSITIONS[from].includes(to)
}

export const listInitiativesQuerySchema = z.object({
  state: z.enum(INITIATIVE_STATES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

export const initiativeIdParamsSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{24}$/i),
})

export const changeInitiativeStateSchema = z
  .object({
    state: z.enum(INITIATIVE_STATES),
  })
  .strict()

export const initiativeSettingsSchema = z
  .object({
    level: z.enum(INITIATIVE_LEVELS),
  })
  .strict()

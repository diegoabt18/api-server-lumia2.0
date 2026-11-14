import { z } from 'zod'
import { DEFAULT_AUTOMATION_TIMEZONE, isValidTime, isValidTimezone, type LumiSchedule } from './schedule.js'

export const TASK_KINDS = ['reminder', 'routine', 'follow_up', 'initiative_review'] as const
export type TaskKind = (typeof TASK_KINDS)[number]

/** active: el scheduler la ejecuta. paused: no se ejecuta hasta reanudar. completed/cancelled: terminal. */
export const TASK_STATUSES = ['active', 'paused', 'completed'] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

export interface LumiTask {
  id: string
  userId: string
  title: string
  description: string | null
  kind: TaskKind
  status: TaskStatus
  schedule: LumiSchedule
  nextRunAt: Date | null
  lastRunAt: Date | null
  /** Tarea de seguimiento: apunta a la rutina cuya revisión la cancela si ya fue confirmada. */
  parentTaskId: string | null
  createdAt: Date
  updatedAt: Date
}

/** Estado de una revisión diaria de una rutina. Una revisión confirmada o suprimida cancela los avisos del día. */
export interface LumiReview {
  taskId: string
  userId: string
  /** Fecha local en la zona de la rutina, AAAA-MM-DD. */
  localDate: string
  reviewedAt: Date | null
  /** "Hoy no me recuerdes más": cancela los avisos del día sin marcar la revisión como hecha. */
  suppressed: boolean
  updatedAt: Date
}

/**
 * Una ocurrencia programada de una tarea. `occurrenceKey` es única: una misma ocurrencia nunca
 * genera dos ejecuciones, aunque el scheduler se solape o el servidor se reinicie.
 */
export type ExecutionStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'dead' | 'skipped'

export interface LumiExecution {
  id: string
  occurrenceKey: string
  taskId: string
  userId: string
  scheduledFor: Date
  status: ExecutionStatus
  attempts: number
  nextAttemptAt: Date
  lockedAt: Date | null
  startedAt: Date | null
  finishedAt: Date | null
  error: string | null
  result: string | null
  createdAt: Date
}

export const MAX_EXECUTION_ATTEMPTS = 3
export const MAX_ACTIVE_TASKS_PER_USER = 100

const scheduleInputSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('once'),
    runAt: z.string().datetime({ offset: true }),
  }),
  z.object({
    type: z.literal('daily'),
    time: z.string().refine(isValidTime, 'Hora inválida (HH:mm, 24 h)'),
    timezone: z
      .string()
      .max(64)
      .optional()
      .default(DEFAULT_AUTOMATION_TIMEZONE)
      .refine(isValidTimezone, 'Zona horaria inválida'),
  }),
])

export type ScheduleInput = z.infer<typeof scheduleInputSchema>

export const createTaskSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).optional(),
  kind: z.enum(TASK_KINDS).default('reminder'),
  schedule: scheduleInputSchema,
})

export const updateTaskSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    schedule: scheduleInputSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nada que actualizar')

export const taskIdParamsSchema = z.object({ id: z.string().regex(/^[a-f0-9]{24}$/) })

export const listTasksQuerySchema = z.object({
  status: z.enum(TASK_STATUSES).optional(),
})

export const listExecutionsQuerySchema = z.object({
  taskId: z.string().regex(/^[a-f0-9]{24}$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
})

export function scheduleFromInput(input: ScheduleInput): LumiSchedule {
  if (input.type === 'once') return { type: 'once', runAt: new Date(input.runAt) }
  return { type: 'daily', time: input.time, timezone: input.timezone }
}

/** Alta de una rutina diaria con segundo aviso opcional (lo usa la UI de Lumi Admin). */
export const createRoutineSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).optional(),
  taskKind: z.enum(['reminder', 'initiative_review']).default('reminder'),
  time: z.string().refine(isValidTime, 'Hora inválida (HH:mm, 24 h)'),
  timezone: z.string().max(64).refine(isValidTimezone, 'Zona horaria inválida').optional(),
  followUpTime: z.string().refine(isValidTime, 'Hora inválida (HH:mm, 24 h)').optional(),
})

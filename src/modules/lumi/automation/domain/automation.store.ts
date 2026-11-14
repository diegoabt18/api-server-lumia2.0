import type { ExecutionStatus, LumiExecution, LumiReview, LumiTask, TaskStatus } from './automation.types.js'
import type { LumiSchedule } from './schedule.js'

/** Campos que pueden cambiar en una tarea. */
export interface TaskPatch {
  title?: string
  description?: string | null
  schedule?: LumiSchedule
  status?: TaskStatus
  nextRunAt?: Date | null
  lastRunAt?: Date | null
}

export interface NewTask {
  userId: string
  title: string
  description: string | null
  kind: LumiTask['kind']
  status: TaskStatus
  schedule: LumiSchedule
  nextRunAt: Date | null
  parentTaskId: string | null
  createdAt: Date
}

export interface NewExecution {
  occurrenceKey: string
  taskId: string
  userId: string
  scheduledFor: Date
  nextAttemptAt: Date
  createdAt: Date
}

export interface ExecutionPatch {
  status: ExecutionStatus
  attempts?: number
  nextAttemptAt?: Date
  lockedAt?: Date | null
  startedAt?: Date | null
  finishedAt?: Date | null
  error?: string | null
  result?: string | null
}

/**
 * Puerto de persistencia del motor. Las implementaciones deben garantizar que las
 * actualizaciones condicionales (`updateTaskIf`, `claimExecution`) son atómicas.
 */
export interface AutomationStore {
  createTask(task: NewTask): Promise<string>
  findTask(id: string): Promise<LumiTask | null>
  findTaskForUser(id: string, userId: string): Promise<LumiTask | null>
  listTasksForUser(userId: string, status?: TaskStatus): Promise<LumiTask[]>
  countOpenTasksForUser(userId: string): Promise<number>
  /** Aplica el parche solo si la tarea sigue en `expected` (status y nextRunAt). */
  updateTaskIf(
    id: string,
    expected: { status?: TaskStatus | TaskStatus[]; nextRunAt?: Date },
    patch: TaskPatch,
  ): Promise<boolean>
  deleteTaskForUser(id: string, userId: string): Promise<boolean>
  findDueTasks(now: Date, limit: number): Promise<LumiTask[]>

  /** Inserta la ocurrencia. Devuelve false si ya existía (deduplicación). */
  insertExecution(execution: NewExecution): Promise<boolean>
  /** Toma la siguiente ejecución lista (pending o failed con reintento vencido) de forma atómica. */
  claimExecution(now: Date, maxAttempts: number): Promise<LumiExecution | null>
  updateExecution(id: string, patch: ExecutionPatch): Promise<void>
  /** Devuelve a `failed` las ejecuciones que quedaron en `running` (servidor reiniciado). */
  recoverStaleExecutions(staleBefore: Date, now: Date): Promise<number>
  findExecution(id: string): Promise<LumiExecution | null>
  listExecutionsForUser(userId: string, taskId: string | undefined, limit: number): Promise<LumiExecution[]>

  findReview(taskId: string, localDate: string): Promise<LumiReview | null>
  /** Crea o actualiza la revisión del día. Solo modifica los campos indicados. */
  upsertReview(
    taskId: string,
    userId: string,
    localDate: string,
    patch: { reviewedAt?: Date; suppressed?: boolean },
    now: Date,
  ): Promise<void>
}

/** Bloqueo distribuido para que solo una instancia ejecute el tick a la vez. */
export interface AutomationLock {
  tryAcquire(key: string, ttlMs: number): Promise<boolean>
  release(key: string): Promise<void>
}

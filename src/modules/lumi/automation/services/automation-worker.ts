import type { AutomationStore } from '../domain/automation.store.js'
import {
  MAX_EXECUTION_ATTEMPTS,
  type LumiExecution,
  type LumiTask,
} from '../domain/automation.types.js'

/** Canal de salida de notificaciones (chat y centro global). Se implementa fuera del motor. */
export interface NotificationSink {
  notify(input: {
    userId: string
    title: string
    message: string
    data: Record<string, string>
  }): Promise<void>
}

export interface WorkerOptions {
  handlerTimeoutMs: number
  maxAttempts: number
  now: () => Date
}

/** Lanzar esto desde un handler cancela la ocurrencia sin reintentos (p. ej. la revisión ya se confirmó). */
export class SkipOccurrence extends Error {}

/** Un handler recibe la tarea ya verificada y devuelve un resumen corto para el historial. */
export type TaskHandler = (task: LumiTask, execution: LumiExecution) => Promise<string>

export const DEFAULT_WORKER_OPTIONS: Omit<WorkerOptions, 'now'> = {
  handlerTimeoutMs: 20_000,
  maxAttempts: MAX_EXECUTION_ATTEMPTS,
}

/** Backoff exponencial acotado: 1 min, 2 min, 4 min… hasta 15 min. */
export function retryDelayMs(attempts: number): number {
  return Math.min(60_000 * 2 ** Math.max(attempts - 1, 0), 15 * 60_000)
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Tiempo agotado (${ms} ms)`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * Worker: ejecuta una ocurrencia ya reclamada. No llama a Qwen: las tareas de Fase 1 son
 * recordatorios que se resuelven con reglas del backend.
 */
export class AutomationWorker {
  private readonly handlers: Partial<Record<LumiTask['kind'], TaskHandler>>

  constructor(
    private readonly store: AutomationStore,
    private readonly notifications: NotificationSink,
    private readonly options: WorkerOptions,
    handlers: Partial<Record<LumiTask['kind'], TaskHandler>> = {},
  ) {
    this.handlers = {
      reminder: this.notifyTask,
      routine: this.notifyTask,
      follow_up: this.notifyTask,
      initiative_review: this.notifyTask,
      ...handlers,
    }
  }

  async execute(execution: LumiExecution): Promise<'succeeded' | 'failed' | 'dead' | 'skipped'> {
    const now = this.options.now()

    // 1. La tarea debe seguir vigente. Una tarea "completed" sí puede ejecutar su última ocurrencia.
    const task = await this.store.findTask(execution.taskId)
    if (!task || task.status === 'paused' || task.userId !== execution.userId) {
      await this.store.updateExecution(execution.id, {
        status: 'skipped',
        finishedAt: now,
        lockedAt: null,
        error: 'Tarea pausada o eliminada antes de ejecutarse',
      })
      return 'skipped'
    }

    // 2. Ejecutar el handler con timeout.
    try {
      const handler = this.handlers[task.kind]
      if (!handler) throw new Error(`Sin handler para ${task.kind}`)
      const result = await withTimeout(handler(task, execution), this.options.handlerTimeoutMs)
      await this.store.updateExecution(execution.id, {
        status: 'succeeded',
        finishedAt: this.options.now(),
        lockedAt: null,
        error: null,
        result: result.slice(0, 500),
      })
      return 'succeeded'
    } catch (err) {
      if (err instanceof SkipOccurrence) {
        await this.store.updateExecution(execution.id, {
          status: 'skipped',
          finishedAt: this.options.now(),
          lockedAt: null,
          error: err.message.slice(0, 500),
        })
        return 'skipped'
      }
      // 3. Reintentos con backoff; al agotarlos la ejecución queda como "dead".
      const message = err instanceof Error ? err.message : 'Error desconocido'
      const failedAt = this.options.now()
      const exhausted = execution.attempts >= this.options.maxAttempts
      await this.store.updateExecution(execution.id, {
        status: exhausted ? 'dead' : 'failed',
        finishedAt: failedAt,
        lockedAt: null,
        ...(exhausted
          ? {}
          : { nextAttemptAt: new Date(failedAt.getTime() + retryDelayMs(execution.attempts)) }),
        error: message.slice(0, 500),
      })
      return exhausted ? 'dead' : 'failed'
    }
  }

  private readonly notifyTask: TaskHandler = async (task, execution) => {
    await this.notifications.notify({
      userId: task.userId,
      title: task.title,
      message: task.description ?? task.title,
      data: { taskId: task.id, executionId: execution.id, kind: task.kind },
    })
    return 'Notificación enviada'
  }
}

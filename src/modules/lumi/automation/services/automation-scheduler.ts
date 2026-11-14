import type { AutomationLock, AutomationStore } from '../domain/automation.store.js'
import { MAX_EXECUTION_ATTEMPTS, type LumiTask } from '../domain/automation.types.js'
import { nextDailyRun } from '../domain/schedule.js'
import type { AutomationWorker } from './automation-worker.js'

export interface SchedulerOptions {
  tickMs: number
  lockTtlMs: number
  /** Ejecuciones máximas por tick: limita la carga sobre el servidor. */
  maxExecutionsPerTick: number
  dueBatchSize: number
  /** Una ejecución "running" más antigua que esto se considera interrumpida. */
  staleAfterMs: number
  maxAttempts: number
}

export const DEFAULT_SCHEDULER_OPTIONS: SchedulerOptions = {
  tickMs: 30_000,
  lockTtlMs: 25_000,
  maxExecutionsPerTick: 5,
  dueBatchSize: 50,
  staleAfterMs: 5 * 60_000,
  maxAttempts: MAX_EXECUTION_ATTEMPTS,
}

export interface TickSummary {
  skippedLock: boolean
  recovered: number
  enqueued: number
  executed: number
}

const LOCK_KEY = 'lumi:automation:tick'

/**
 * Scheduler único del motor. Cada tick:
 * 1. Recupera ejecuciones que quedaron "running" (reinicio).
 * 2. Encola las ocurrencias vencidas. Cada ocurrencia tiene clave única, así que no se duplica
 *    aunque el tick se solape o el servidor se reinicie a mitad del proceso.
 * 3. Ejecuta, en serie, un número acotado de ejecuciones pendientes.
 *
 * Una tarea vencida varios días genera UNA sola ejecución de recuperación; después se programa la
 * siguiente ocurrencia futura. No se encadenan ejecuciones atrasadas.
 */
export class AutomationScheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  private inProgress = false

  constructor(
    private readonly store: AutomationStore,
    private readonly lock: AutomationLock,
    private readonly worker: AutomationWorker,
    private readonly options: SchedulerOptions,
    private readonly now: () => Date = () => new Date(),
    private readonly onError: (err: unknown) => void = () => {},
  ) {}

  start(): void {
    if (this.timer) return
    // Primer tick a los pocos segundos del arranque: recupera lo pendiente tras un reinicio.
    setTimeout(() => void this.tick().catch(this.onError), 5_000).unref?.()
    this.timer = setInterval(() => void this.tick().catch(this.onError), this.options.tickMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async tick(): Promise<TickSummary> {
    const summary: TickSummary = { skippedLock: false, recovered: 0, enqueued: 0, executed: 0 }
    // Evita solapes dentro del mismo proceso; el lock Redis evita solapes entre instancias.
    if (this.inProgress) return { ...summary, skippedLock: true }
    this.inProgress = true
    try {
      const acquired = await this.lock.tryAcquire(LOCK_KEY, this.options.lockTtlMs)
      if (!acquired) return { ...summary, skippedLock: true }
      try {
        const now = this.now()
        summary.recovered = await this.store.recoverStaleExecutions(
          new Date(now.getTime() - this.options.staleAfterMs),
          now,
        )

        const due = await this.store.findDueTasks(now, this.options.dueBatchSize)
        for (const task of due) {
          if (await this.enqueueOccurrence(task, now)) summary.enqueued += 1
        }

        for (let i = 0; i < this.options.maxExecutionsPerTick; i += 1) {
          const execution = await this.store.claimExecution(this.now(), this.options.maxAttempts)
          if (!execution) break
          await this.worker.execute(execution)
          summary.executed += 1
        }
      } finally {
        await this.lock.release(LOCK_KEY)
      }
      return summary
    } finally {
      this.inProgress = false
    }
  }

  /** Crea la ejecución de la ocurrencia y avanza la tarea. Devuelve true si la ocurrencia es nueva. */
  private async enqueueOccurrence(task: LumiTask, now: Date): Promise<boolean> {
    if (!task.nextRunAt) return false
    const scheduledFor = task.nextRunAt
    const created = await this.store.insertExecution({
      occurrenceKey: `${task.id}|${scheduledFor.toISOString()}`,
      taskId: task.id,
      userId: task.userId,
      scheduledFor,
      nextAttemptAt: now,
      createdAt: now,
    })

    // Avance condicional: si otra pasada ya avanzó la tarea, no se toca.
    const nextRunAt =
      task.schedule.type === 'daily'
        ? nextDailyRun(task.schedule.time, task.schedule.timezone, now)
        : null
    await this.store.updateTaskIf(
      task.id,
      { status: 'active', nextRunAt: scheduledFor },
      {
        nextRunAt,
        lastRunAt: now,
        ...(task.schedule.type === 'once' ? { status: 'completed' as const } : {}),
      },
    )
    return created
  }
}

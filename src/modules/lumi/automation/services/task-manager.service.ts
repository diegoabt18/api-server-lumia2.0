import { AppError } from '../../../../common/errors/app.error.js'
import type { AutomationStore, TaskPatch } from '../domain/automation.store.js'
import {
  MAX_ACTIVE_TASKS_PER_USER,
  scheduleFromInput,
  type ScheduleInput,
  type TaskStatus,
  type LumiExecution,
  type LumiTask,
} from '../domain/automation.types.js'
import { DEFAULT_AUTOMATION_TIMEZONE, firstRunAt, type LumiSchedule } from '../domain/schedule.js'

export interface CreateTaskInput {
  title: string
  description?: string
  kind: LumiTask['kind']
  schedule: ScheduleInput
}

export interface CreateRoutineInput {
  title: string
  description: string | null
  taskKind: 'initiative_review' | 'reminder'
  time: string
  timezone?: string
  followUpTime: string | null
}

export interface UpdateTaskInput {
  title?: string
  description?: string | null
  schedule?: ScheduleInput
}

/**
 * Task Manager: reglas de negocio de tareas, recordatorios y rutinas. Toda operación pasa por aquí;
 * ni el modelo ni el navegador escriben directamente en la base de datos.
 */
export class LumiTaskManager {
  constructor(
    private readonly store: AutomationStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(userId: string, input: CreateTaskInput): Promise<LumiTask> {
    const open = await this.store.countOpenTasksForUser(userId)
    if (open >= MAX_ACTIVE_TASKS_PER_USER) {
      throw AppError.badRequest(`Límite de ${MAX_ACTIVE_TASKS_PER_USER} tareas abiertas alcanzado`)
    }
    const now = this.now()
    const schedule = scheduleFromInput(input.schedule)
    this.assertFuture(schedule, now)

    const id = await this.store.createTask({
      userId,
      title: input.title,
      description: input.description?.length ? input.description : null,
      kind: input.kind,
      status: 'active',
      schedule,
      nextRunAt: firstRunAt(schedule, now),
      parentTaskId: null,
      createdAt: now,
    })
    return this.getForUser(userId, id)
  }

  /**
   * Rutina diaria con segundo aviso opcional. La rutina y su seguimiento se crean enlazados:
   * la revisión de la rutina decide si el seguimiento se envía.
   */
  async createRoutine(userId: string, input: CreateRoutineInput): Promise<{ routine: LumiTask; followUp: LumiTask | null }> {
    const open = await this.store.countOpenTasksForUser(userId)
    const needed = input.followUpTime ? 2 : 1
    if (open + needed > MAX_ACTIVE_TASKS_PER_USER) {
      throw AppError.badRequest(`Límite de ${MAX_ACTIVE_TASKS_PER_USER} tareas abiertas alcanzado`)
    }
    const now = this.now()
    const timezone = input.timezone ?? DEFAULT_AUTOMATION_TIMEZONE
    const routineId = await this.store.createTask({
      userId,
      title: input.title,
      description: input.description,
      kind: input.taskKind,
      status: 'active',
      schedule: { type: 'daily', time: input.time, timezone },
      nextRunAt: firstRunAt({ type: 'daily', time: input.time, timezone }, now),
      parentTaskId: null,
      createdAt: now,
    })
    let followUpId: string | null = null
    if (input.followUpTime) {
      followUpId = await this.store.createTask({
        userId,
        title: `Segundo aviso: ${input.title}`,
        description: null,
        kind: 'follow_up',
        status: 'active',
        schedule: { type: 'daily', time: input.followUpTime, timezone },
        nextRunAt: firstRunAt({ type: 'daily', time: input.followUpTime, timezone }, now),
        parentTaskId: routineId,
        createdAt: now,
      })
    }
    return {
      routine: await this.getForUser(userId, routineId),
      followUp: followUpId ? await this.getForUser(userId, followUpId) : null,
    }
  }

  /** Seguimientos de una rutina. */
  async followUpsOf(userId: string, routineId: string): Promise<LumiTask[]> {
    const all = await this.store.listTasksForUser(userId)
    return all.filter((t) => t.parentTaskId === routineId)
  }

  list(userId: string, status?: TaskStatus): Promise<LumiTask[]> {
    return this.store.listTasksForUser(userId, status)
  }

  getForUser(userId: string, id: string): Promise<LumiTask> {
    return this.store.findTaskForUser(id, userId).then((task) => {
      if (!task) throw AppError.notFound('Tarea no encontrada')
      return task
    })
  }

  async update(userId: string, id: string, input: UpdateTaskInput): Promise<LumiTask> {
    const task = await this.getForUser(userId, id)
    if (task.status === 'completed') throw AppError.conflict('La tarea ya está completada')

    const patch: TaskPatch = {}
    if (input.title !== undefined) patch.title = input.title
    if (input.description !== undefined) patch.description = input.description?.length ? input.description : null
    if (input.schedule) {
      const now = this.now()
      const schedule = scheduleFromInput(input.schedule)
      this.assertFuture(schedule, now)
      patch.schedule = schedule
      // Una tarea pausada recalcula su próxima ejecución al reanudarse.
      patch.nextRunAt = task.status === 'active' ? firstRunAt(schedule, now) : null
    }

    const applied = await this.store.updateTaskIf(id, { status: task.status }, patch)
    if (!applied) throw AppError.conflict('La tarea cambió de estado. Vuelve a intentarlo')
    return this.getForUser(userId, id)
  }

  async pause(userId: string, id: string): Promise<LumiTask> {
    const task = await this.getForUser(userId, id)
    if (task.status !== 'active') throw AppError.conflict('Solo se pueden pausar tareas activas')
    await this.store.updateTaskIf(id, { status: 'active' }, { status: 'paused' })
    return this.getForUser(userId, id)
  }

  async resume(userId: string, id: string): Promise<LumiTask> {
    const task = await this.getForUser(userId, id)
    if (task.status !== 'paused') throw AppError.conflict('Solo se pueden reanudar tareas pausadas')
    const now = this.now()
    if (task.schedule.type === 'once' && task.schedule.runAt.getTime() <= now.getTime()) {
      throw AppError.badRequest('La hora de este recordatorio ya pasó. Edítala o crea una nueva')
    }
    const nextRunAt = firstRunAt(task.schedule, now)
    await this.store.updateTaskIf(id, { status: 'paused' }, { status: 'active', nextRunAt })
    return this.getForUser(userId, id)
  }

  async complete(userId: string, id: string): Promise<LumiTask> {
    const task = await this.getForUser(userId, id)
    if (task.status === 'completed') return task
    await this.store.updateTaskIf(
      id,
      { status: task.status },
      { status: 'completed', nextRunAt: null },
    )
    return this.getForUser(userId, id)
  }

  /** Elimina la tarea y sus seguimientos enlazados. */
  async remove(userId: string, id: string): Promise<void> {
    const children = await this.followUpsOf(userId, id)
    const deleted = await this.store.deleteTaskForUser(id, userId)
    if (!deleted) throw AppError.notFound('Tarea no encontrada')
    for (const child of children) await this.store.deleteTaskForUser(child.id, userId)
  }

  listExecutions(userId: string, taskId: string | undefined, limit: number): Promise<LumiExecution[]> {
    return this.store.listExecutionsForUser(userId, taskId, limit)
  }

  private assertFuture(schedule: LumiSchedule, now: Date): void {
    if (schedule.type === 'once' && schedule.runAt.getTime() <= now.getTime()) {
      throw AppError.badRequest('La hora indicada ya pasó')
    }
  }
}

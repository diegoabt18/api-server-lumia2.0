import { AppError } from '../../../../common/errors/app.error.js'
import type { AutomationStore } from '../domain/automation.store.js'
import type { LumiTask } from '../domain/automation.types.js'
import { parseAutomationCommand } from '../domain/reminder-parser.js'
import { DEFAULT_AUTOMATION_TIMEZONE, localDateKey } from '../domain/schedule.js'
import type { LumiTaskManager } from './task-manager.service.js'

/** "08:00" → "8:00 a. m.", "14:00" → "2:00 p. m." (formato de la confirmación a la persona). */
export function formatClock(time: string): string {
  const [h, m] = time.split(':').map(Number) as [number, number]
  const suffix = h < 12 ? 'a. m.' : 'p. m.'
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${suffix}`
}

/** Añade el punto final solo si la frase no lo trae (las horas "a. m." / "p. m." ya terminan en punto). */
function sentence(text: string): string {
  return text.endsWith('.') ? text : `${text}.`
}

/**
 * Comandos conversacionales del motor. El chat llama a `handle` antes de consultar al modelo:
 * si la frase es una orden de recordatorio, se resuelve aquí por reglas y el backend ejecuta la
 * operación. Devuelve null cuando el mensaje no es una orden de automatización.
 */
export class AutomationCommands {
  constructor(
    private readonly manager: LumiTaskManager,
    private readonly store: AutomationStore,
    private readonly now: () => Date = () => new Date(),
    private readonly timezone: string = DEFAULT_AUTOMATION_TIMEZONE,
  ) {}

  async handle(userId: string, message: string): Promise<string | null> {
    const cmd = parseAutomationCommand(message, this.now(), this.timezone)
    switch (cmd.kind) {
      case 'none':
        return null
      case 'ask':
      case 'unsupported':
        return cmd.kind === 'ask' ? cmd.question : cmd.reason
      case 'create_routine': {
        await this.manager.createRoutine(userId, {
          title: cmd.title,
          description: cmd.description,
          taskKind: cmd.taskKind,
          time: cmd.time,
          timezone: this.timezone,
          followUpTime: cmd.followUpTime,
        })
        const first = formatClock(cmd.time)
        const second = cmd.followUpTime ? formatClock(cmd.followUpTime) : null
        if (cmd.taskKind === 'initiative_review') {
          return sentence(
            second
              ? `He creado tu revisión diaria de iniciativas. Te avisaré a las ${first} y nuevamente a las ${second} si todavía no la has revisado`
              : `He creado tu revisión diaria de iniciativas. Te avisaré todos los días a las ${first}`,
          )
        }
        return sentence(
          `He creado tu recordatorio diario. Te avisaré todos los días a las ${first}${second ? ` y nuevamente a las ${second} si no lo confirmas` : ''}`,
        )
      }
      case 'create_reminder': {
        const task = await this.manager.create(userId, {
          title: cmd.title,
          kind: 'reminder',
          schedule: { type: 'once', runAt: cmd.runAt.toISOString() },
        })
        return `Listo. Te recordaré «${task.title}» el ${this.formatDate(cmd.runAt)}.`
      }
      case 'mark_reviewed':
        return this.markReview(userId, 'reviewed')
      case 'suppress_today':
        return this.markReview(userId, 'suppressed')
      case 'set_followup_time':
        return this.changeFollowUp(userId, cmd.time)
      case 'list':
        return this.list(userId)
      case 'pause':
        return this.pauseOrResume(userId, 'pause')
      case 'resume':
        return this.pauseOrResume(userId, 'resume')
      case 'delete':
        return this.deleteRoutine(userId)
    }
  }

  /**
   * Confirma la revisión de hoy de la rutina a la que pertenece `taskId` (la rutina o su seguimiento).
   * Lo usa la acción "Marcar como revisado" de una notificación. Devuelve false si no hay rutina.
   */
  async confirmReview(userId: string, taskId: string): Promise<boolean> {
    const task = await this.store.findTaskForUser(taskId, userId)
    if (!task) return false
    const routine = task.parentTaskId
      ? await this.store.findTaskForUser(task.parentTaskId, userId)
      : task
    if (!routine || routine.kind === 'follow_up') return false
    const now = this.now()
    await this.store.upsertReview(
      routine.id,
      userId,
      localDateKey(now, this.timezoneOf(routine)),
      { reviewedAt: now },
      now,
    )
    return true
  }

  private async routines(userId: string, status?: LumiTask['status']): Promise<LumiTask[]> {
    const all = await this.store.listTasksForUser(userId, status)
    return all.filter((t) => t.parentTaskId === null && t.kind !== 'follow_up')
  }

  private async markReview(userId: string, mode: 'reviewed' | 'suppressed'): Promise<string> {
    const routines = await this.routines(userId, 'active')
    if (routines.length === 0) return 'No tienes una revisión diaria activa.'
    const now = this.now()
    for (const routine of routines) {
      const day = localDateKey(now, this.timezoneOf(routine))
      await this.store.upsertReview(
        routine.id,
        userId,
        day,
        mode === 'reviewed' ? { reviewedAt: now } : { suppressed: true },
        now,
      )
    }
    const initiative = routines.some((r) => r.kind === 'initiative_review')
    if (mode === 'reviewed') {
      return initiative
        ? 'Revisión de hoy marcada. Cancelé el segundo aviso de hoy; tus iniciativas siguen pendientes.'
        : 'Listo, marqué como revisado hoy. Cancelé el segundo aviso de hoy.'
    }
    return 'Entendido, no te recordaré más hoy. Tus iniciativas siguen pendientes.'
  }

  private async changeFollowUp(userId: string, time: string): Promise<string> {
    const routines = await this.routines(userId, 'active')
    let changed = 0
    for (const routine of routines) {
      const followUps = await this.manager.followUpsOf(userId, routine.id)
      for (const follow of followUps) {
        await this.manager.update(userId, follow.id, {
          schedule: { type: 'daily', time, timezone: this.timezoneOf(routine) },
        })
        changed += 1
      }
    }
    if (changed === 0) return 'No tienes un segundo recordatorio que cambiar.'
    return sentence(`Listo. El segundo recordatorio será a las ${formatClock(time)}`)
  }

  private async list(userId: string): Promise<string> {
    const tasks = (await this.store.listTasksForUser(userId)).filter((t) => t.parentTaskId === null && t.status !== 'completed')
    if (tasks.length === 0) return 'No tienes rutinas ni recordatorios activos.'
    const lines: string[] = []
    for (const task of tasks) {
      const state = task.status === 'paused' ? ' (pausada)' : ''
      if (task.schedule.type === 'once') {
        lines.push(`- ${task.title}: ${this.formatDate(task.schedule.runAt)}${state}`)
        continue
      }
      const follow = (await this.manager.followUpsOf(userId, task.id))[0]
      const second = follow && follow.schedule.type === 'daily' ? ` y nuevamente a las ${formatClock(follow.schedule.time)}` : ''
      lines.push(`- ${task.title}: todos los días a las ${formatClock(task.schedule.time)}${second}${state}`)
    }
    return `Tienes ${tasks.length} ${tasks.length === 1 ? 'elemento' : 'elementos'} programados:\n${lines.join('\n')}`
  }

  private async pauseOrResume(userId: string, action: 'pause' | 'resume'): Promise<string> {
    const wanted = action === 'pause' ? 'active' : 'paused'
    const routines = await this.routines(userId, wanted)
    let count = 0
    for (const routine of routines) {
      const targets = [routine, ...(await this.manager.followUpsOf(userId, routine.id))]
      for (const task of targets) {
        if (task.status !== wanted) continue
        try {
          if (action === 'pause') await this.manager.pause(userId, task.id)
          else await this.manager.resume(userId, task.id)
          count += 1
        } catch (err) {
          // Un recordatorio puntual ya vencido no se puede reanudar: se informa al final.
          if (!(err instanceof AppError)) throw err
        }
      }
    }
    if (count === 0) {
      return action === 'pause' ? 'No tienes rutinas activas para pausar.' : 'No tienes rutinas pausadas para reactivar.'
    }
    return action === 'pause'
      ? `Pausé ${count} ${count === 1 ? 'aviso' : 'avisos'}. Dime «reactívalos» cuando quieras retomarlos.`
      : `Reactivé ${count} ${count === 1 ? 'aviso' : 'avisos'}.`
  }

  private async deleteRoutine(userId: string): Promise<string> {
    const routines = await this.routines(userId)
    if (routines.length === 0) return 'No tienes rutinas que eliminar.'
    if (routines.length > 1) {
      const names = routines.map((r) => `«${r.title}»`).join(', ')
      return `Tienes varias rutinas: ${names}. Dime cuál quieres eliminar.`
    }
    await this.manager.remove(userId, routines[0]!.id)
    return `Eliminé «${routines[0]!.title}» y su segundo aviso.`
  }

  private timezoneOf(task: LumiTask): string {
    return task.schedule.type === 'daily' ? task.schedule.timezone : this.timezone
  }

  private formatDate(date: Date): string {
    return new Intl.DateTimeFormat('es-CO', {
      timeZone: this.timezone,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      hour: 'numeric',
      minute: '2-digit',
    }).format(date)
  }
}

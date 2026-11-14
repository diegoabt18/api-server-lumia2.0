import type { AutomationStore } from '../domain/automation.store.js'
import { DEFAULT_AUTOMATION_TIMEZONE, localDateKey, type LumiSchedule } from '../domain/schedule.js'
import type { NotificationSink, TaskHandler } from './automation-worker.js'
import { SkipOccurrence } from './automation-worker.js'

function timezoneOf(schedule: LumiSchedule): string {
  return schedule.type === 'daily' ? schedule.timezone : DEFAULT_AUTOMATION_TIMEZONE
}

/**
 * Handler del segundo aviso. Antes de notificar consulta la revisión del día de la rutina padre:
 * si ya fue confirmada (o el usuario pidió no recibir más avisos hoy), la ocurrencia se cancela.
 * La decisión queda persistida; no depende de ocultar la notificación en el cliente.
 */
export function createFollowUpHandler(
  store: AutomationStore,
  notifications: NotificationSink,
): TaskHandler {
  return async (task, execution) => {
    if (!task.parentTaskId) throw new SkipOccurrence('Seguimiento sin rutina asociada')
    const parent = await store.findTask(task.parentTaskId)
    if (!parent) throw new SkipOccurrence('La rutina asociada ya no existe')
    if (parent.status !== 'active') throw new SkipOccurrence('La rutina asociada no está activa')

    const day = localDateKey(execution.scheduledFor, timezoneOf(parent.schedule))
    const review = await store.findReview(parent.id, day)
    if (review?.reviewedAt) throw new SkipOccurrence(`Revisión confirmada el ${day}`)
    if (review?.suppressed) throw new SkipOccurrence(`Avisos suspendidos para el ${day}`)

    await notifications.notify({
      userId: task.userId,
      title: parent.title,
      message: 'Todavía no has revisado tus iniciativas de hoy.',
      data: { taskId: task.id, parentTaskId: parent.id, executionId: execution.id, kind: 'follow_up' },
    })
    return 'Segundo aviso enviado'
  }
}

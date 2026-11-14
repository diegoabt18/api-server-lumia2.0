import { describe, expect, it } from 'vitest'
import type { AutomationStore, TaskPatch } from '../../src/modules/lumi/automation/domain/automation.store.js'
import type { LumiExecution, LumiReview, LumiTask } from '../../src/modules/lumi/automation/domain/automation.types.js'
import { parseAutomationCommand } from '../../src/modules/lumi/automation/domain/reminder-parser.js'
import { AutomationCommands, formatClock } from '../../src/modules/lumi/automation/services/automation-commands.js'
import { AutomationWorker, type NotificationSink } from '../../src/modules/lumi/automation/services/automation-worker.js'
import { createFollowUpHandler } from '../../src/modules/lumi/automation/services/reminder-handlers.js'
import { LumiTaskManager } from '../../src/modules/lumi/automation/services/task-manager.service.js'

// 12:00 UTC = 07:00 hora de Bogotá, 13 nov 2026
const NOW = new Date('2026-11-13T12:00:00.000Z')
const TZ = 'America/Bogota'

describe('parser de instrucciones de recordatorio', () => {
  it('crea la rutina diaria con segundo aviso del ejemplo del prompt', () => {
    const cmd = parseAutomationCommand(
      'Todos los días a las 8 de la mañana revisa qué iniciativas tengo pendientes y envíame un recordatorio. Si no las he revisado, vuelve a recordármelo a las 2 de la tarde.',
      NOW,
      TZ,
    )
    expect(cmd).toMatchObject({
      kind: 'create_routine',
      taskKind: 'initiative_review',
      time: '08:00',
      followUpTime: '14:00',
    })
  })

  it('pide la hora cuando falta en un recordatorio de mañana', () => {
    expect(parseAutomationCommand('Recuérdame llamar al proveedor mañana', NOW, TZ)).toEqual({
      kind: 'ask',
      question: '¿A qué hora quieres el recordatorio?',
    })
  })

  it('calcula la hora exacta de un recordatorio de mañana a las 10 de la mañana (Bogotá)', () => {
    const cmd = parseAutomationCommand('Recuérdame llamar al proveedor mañana a las 10 de la mañana', NOW, TZ)
    expect(cmd.kind).toBe('create_reminder')
    if (cmd.kind !== 'create_reminder') return
    expect(cmd.runAt.toISOString()).toBe('2026-11-14T15:00:00.000Z')
    expect(cmd.title).toBe('llamar al proveedor')
  })

  it('interpreta "en dos horas" de forma relativa', () => {
    const cmd = parseAutomationCommand('Recuérdame esto nuevamente en dos horas', NOW, TZ)
    expect(cmd.kind === 'create_reminder' && cmd.runAt.toISOString()).toBe('2026-11-13T14:00:00.000Z')
  })

  it('pregunta mañana o tarde cuando la hora es ambigua', () => {
    expect(parseAutomationCommand('Todos los días a las 8 revisa mis iniciativas', NOW, TZ)).toMatchObject({
      kind: 'ask',
    })
  })

  it('reconoce las órdenes de revisión, supresión y cambio de hora', () => {
    expect(parseAutomationCommand('Ya revisé las iniciativas', NOW, TZ)).toEqual({ kind: 'mark_reviewed' })
    expect(parseAutomationCommand('Marcar como revisado', NOW, TZ)).toEqual({ kind: 'mark_reviewed' })
    expect(parseAutomationCommand('Hoy no me recuerdes más', NOW, TZ)).toEqual({ kind: 'suppress_today' })
    expect(parseAutomationCommand('Cambia el segundo recordatorio para las 4 de la tarde', NOW, TZ)).toEqual({
      kind: 'set_followup_time',
      time: '16:00',
    })
    expect(parseAutomationCommand('Cambia el segundo recordatorio para las 4', NOW, TZ)).toMatchObject({ kind: 'ask' })
  })

  it('reconoce listar, pausar, reanudar y eliminar; no soporta pausas por días', () => {
    expect(parseAutomationCommand('Muéstrame mis rutinas activas', NOW, TZ)).toEqual({ kind: 'list' })
    expect(parseAutomationCommand('¿Qué tareas tengo pendientes?', NOW, TZ)).toEqual({ kind: 'list' })
    expect(parseAutomationCommand('Pausa esta rutina una semana', NOW, TZ)).toMatchObject({ kind: 'unsupported' })
    expect(parseAutomationCommand('Reactiva mis recordatorios', NOW, TZ)).toEqual({ kind: 'resume' })
    expect(parseAutomationCommand('Elimina la revisión diaria', NOW, TZ)).toEqual({ kind: 'delete' })
  })

  it('no toma como orden una pregunta general', () => {
    expect(parseAutomationCommand('¿Cuál es el clima en Bogotá?', NOW, TZ)).toEqual({ kind: 'none' })
  })

  it('formatea las horas como en la confirmación', () => {
    expect(formatClock('08:00')).toBe('8:00 a. m.')
    expect(formatClock('14:00')).toBe('2:00 p. m.')
  })
})

/** Store mínimo en memoria: solo las operaciones que usan el Task Manager, los comandos y el worker. */
class MemoryStore {
  tasks = new Map<string, LumiTask>()
  reviews = new Map<string, LumiReview>()
  executions = new Map<string, LumiExecution>()
  private seq = 0

  async createTask(task: Parameters<AutomationStore['createTask']>[0]) {
    const id = `t${++this.seq}`
    this.tasks.set(id, { ...task, id, lastRunAt: null, updatedAt: task.createdAt } as LumiTask)
    return id
  }
  async findTask(id: string) {
    return this.tasks.get(id) ?? null
  }
  async findTaskForUser(id: string, userId: string) {
    const t = this.tasks.get(id)
    return t && t.userId === userId ? t : null
  }
  async listTasksForUser(userId: string, status?: LumiTask['status']) {
    return [...this.tasks.values()].filter((t) => t.userId === userId && (!status || t.status === status))
  }
  async countOpenTasksForUser(userId: string) {
    return (await this.listTasksForUser(userId)).filter((t) => t.status !== 'completed').length
  }
  async updateTaskIf(id: string, expected: { status?: LumiTask['status'] | LumiTask['status'][] }, patch: TaskPatch) {
    const t = this.tasks.get(id)
    if (!t) return false
    if (expected.status !== undefined) {
      const allowed = Array.isArray(expected.status) ? expected.status : [expected.status]
      if (!allowed.includes(t.status)) return false
    }
    Object.assign(t, patch)
    return true
  }
  async deleteTaskForUser(id: string, userId: string) {
    const t = this.tasks.get(id)
    if (!t || t.userId !== userId) return false
    this.tasks.delete(id)
    return true
  }
  async findReview(taskId: string, localDate: string) {
    return this.reviews.get(`${taskId}|${localDate}`) ?? null
  }
  async upsertReview(
    taskId: string,
    userId: string,
    localDate: string,
    patch: { reviewedAt?: Date; suppressed?: boolean },
    now: Date,
  ) {
    const key = `${taskId}|${localDate}`
    const prev = this.reviews.get(key)
    this.reviews.set(key, {
      taskId,
      userId,
      localDate,
      reviewedAt: patch.reviewedAt ?? prev?.reviewedAt ?? null,
      suppressed: patch.suppressed ?? prev?.suppressed ?? false,
      updatedAt: now,
    })
  }
  async updateExecution(id: string, patch: Partial<LumiExecution> & { status: LumiExecution['status'] }) {
    Object.assign(this.executions.get(id)!, patch)
  }
}

function setup() {
  let now = NOW
  const store = new MemoryStore()
  const sent: string[] = []
  const sink: NotificationSink = {
    async notify(input) {
      sent.push(input.title)
    },
  }
  const manager = new LumiTaskManager(store as unknown as AutomationStore, () => now)
  const commands = new AutomationCommands(manager, store as unknown as AutomationStore, () => now, TZ)
  const worker = new AutomationWorker(
    store as unknown as AutomationStore,
    sink,
    { handlerTimeoutMs: 1000, maxAttempts: 3, now: () => now },
    { follow_up: createFollowUpHandler(store as unknown as AutomationStore, sink) },
  )
  return {
    store,
    sent,
    commands,
    worker,
    setNow(value: string) {
      now = new Date(value)
    },
  }
}

/** Ejecución del segundo aviso a una hora local dada, lista para el worker. */
function followUpExecution(store: MemoryStore, followUp: LumiTask, scheduledFor: string): LumiExecution {
  const exec: LumiExecution = {
    id: `e-${store.executions.size + 1}`,
    occurrenceKey: `${followUp.id}|${scheduledFor}`,
    taskId: followUp.id,
    userId: followUp.userId,
    scheduledFor: new Date(scheduledFor),
    status: 'running',
    attempts: 1,
    nextAttemptAt: new Date(scheduledFor),
    lockedAt: null,
    startedAt: null,
    finishedAt: null,
    error: null,
    result: null,
    createdAt: new Date(scheduledFor),
  }
  store.executions.set(exec.id, exec)
  return exec
}

async function createDailyReviewRoutine(t: ReturnType<typeof setup>) {
  const reply = await t.commands.handle(
    'u1',
    'Todos los días a las 8 de la mañana revisa qué iniciativas tengo pendientes y envíame un recordatorio. Si no las he revisado, vuelve a recordármelo a las 2 de la tarde.',
  )
  const routine = [...t.store.tasks.values()].find((x) => x.parentTaskId === null)!
  const followUp = [...t.store.tasks.values()].find((x) => x.parentTaskId === routine.id)!
  return { reply, routine, followUp }
}

// 14:00 Bogotá = 19:00 UTC
const TWO_PM = '2026-11-13T19:00:00.000Z'

describe('revisión diaria: cancelación del segundo aviso', () => {
  it('crea la rutina y el segundo aviso enlazados y confirma en lenguaje natural', async () => {
    const t = setup()
    const { reply, routine, followUp } = await createDailyReviewRoutine(t)
    expect(reply).toBe(
      'He creado tu revisión diaria de iniciativas. Te avisaré a las 8:00 a. m. y nuevamente a las 2:00 p. m. si todavía no la has revisado.',
    )
    expect(routine.schedule).toMatchObject({ type: 'daily', time: '08:00', timezone: TZ })
    expect(followUp.kind).toBe('follow_up')
    expect(followUp.schedule).toMatchObject({ type: 'daily', time: '14:00' })
  })

  it('si no hay revisión, el segundo aviso se envía a las 2 de la tarde', async () => {
    const t = setup()
    const { followUp } = await createDailyReviewRoutine(t)
    const exec = followUpExecution(t.store, followUp, TWO_PM)
    expect(await t.worker.execute(exec)).toBe('succeeded')
    expect(t.sent).toEqual(['Revisar iniciativas pendientes'])
  })

  it('"Marcar como revisado" a la mañana cancela el segundo aviso de ese día', async () => {
    const t = setup()
    const { followUp } = await createDailyReviewRoutine(t)
    t.setNow('2026-11-13T14:00:00.000Z') // 9:00 Bogotá
    const reply = await t.commands.handle('u1', 'Ya revisé las iniciativas')
    expect(reply).toContain('tus iniciativas siguen pendientes')

    t.setNow(TWO_PM)
    const exec = followUpExecution(t.store, followUp, TWO_PM)
    expect(await t.worker.execute(exec)).toBe('skipped')
    expect(exec.error).toContain('Revisión confirmada')
    expect(t.sent).toEqual([])
  })

  it('"Hoy no me recuerdes más" cancela los avisos del día sin marcar la revisión', async () => {
    const t = setup()
    const { routine, followUp } = await createDailyReviewRoutine(t)
    await t.commands.handle('u1', 'Hoy no me recuerdes más')
    const review = await t.store.findReview(routine.id, '2026-11-13')
    expect(review?.suppressed).toBe(true)
    expect(review?.reviewedAt).toBeNull()

    const exec = followUpExecution(t.store, followUp, TWO_PM)
    expect(await t.worker.execute(exec)).toBe('skipped')
    expect(t.sent).toEqual([])
  })

  it('cambia la hora del segundo aviso y la nueva hora queda persistida', async () => {
    const t = setup()
    const { followUp } = await createDailyReviewRoutine(t)
    const reply = await t.commands.handle('u1', 'Cambia el segundo recordatorio para las 4 de la tarde')
    expect(reply).toBe('Listo. El segundo recordatorio será a las 4:00 p. m.')
    expect(t.store.tasks.get(followUp.id)!.schedule).toMatchObject({ time: '16:00' })
  })

  it('pausa y reanuda rutina y seguimiento juntos; eliminar la rutina borra también el seguimiento', async () => {
    const t = setup()
    const { routine, followUp } = await createDailyReviewRoutine(t)
    expect(await t.commands.handle('u1', 'Pausa esta rutina una semana')).toContain('todavía no programo pausas')
    expect(await t.commands.handle('u1', 'Pausa mis recordatorios')).toBe(
      'Pausé 2 avisos. Dime «reactívalos» cuando quieras retomarlos.',
    )
    expect(t.store.tasks.get(routine.id)!.status).toBe('paused')
    expect(t.store.tasks.get(followUp.id)!.status).toBe('paused')

    expect(await t.commands.handle('u1', 'Reactiva mis recordatorios')).toBe('Reactivé 2 avisos.')
    expect(t.store.tasks.get(followUp.id)!.status).toBe('active')

    expect(await t.commands.handle('u1', 'Elimina la revisión diaria')).toBe(
      'Eliminé «Revisar iniciativas pendientes» y su segundo aviso.',
    )
    expect(t.store.tasks.size).toBe(0)
  })

  it('no elimina nada si hay varias rutinas: pide cuál', async () => {
    const t = setup()
    await createDailyReviewRoutine(t)
    await t.commands.handle('u1', 'Todos los días a las 9 de la mañana recuérdame tomar agua')
    expect(await t.commands.handle('u1', 'Elimina la revisión diaria')).toContain('Dime cuál quieres eliminar')
    expect(t.store.tasks.size).toBeGreaterThan(1)
  })

  it('una orden ambigua no crea nada y devuelve la pregunta', async () => {
    const t = setup()
    const reply = await t.commands.handle('u1', 'Recuérdame llamar al proveedor mañana')
    expect(reply).toBe('¿A qué hora quieres el recordatorio?')
    expect(t.store.tasks.size).toBe(0)
  })

  it('un mensaje que no es orden devuelve null para que siga al modelo', async () => {
    const t = setup()
    expect(await t.commands.handle('u1', '¿Cuál es el clima en Bogotá?')).toBeNull()
  })
})

describe('confirmación desde una notificación', () => {
  it('confirmar la revisión desde el seguimiento cancela su aviso de las 2 p. m.', async () => {
    const t = setup()
    const { routine, followUp } = await createDailyReviewRoutine(t)
    t.setNow('2026-11-13T14:00:00.000Z')
    expect(await t.commands.confirmReview('u1', followUp.id)).toBe(true)
    expect((await t.store.findReview(routine.id, '2026-11-13'))?.reviewedAt).toEqual(new Date('2026-11-13T14:00:00.000Z'))

    t.setNow(TWO_PM)
    const exec = followUpExecution(t.store, followUp, TWO_PM)
    expect(await t.worker.execute(exec)).toBe('skipped')
  })

  it('no confirma una tarea de otro usuario', async () => {
    const t = setup()
    const { followUp } = await createDailyReviewRoutine(t)
    expect(await t.commands.confirmReview('otro-usuario', followUp.id)).toBe(false)
  })
})

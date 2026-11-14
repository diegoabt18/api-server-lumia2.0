import { describe, expect, it } from 'vitest'
import type { AutomationLock, AutomationStore, NewExecution, TaskPatch } from '../../src/modules/lumi/automation/domain/automation.store.js'
import type { ExecutionStatus, LumiExecution, LumiTask } from '../../src/modules/lumi/automation/domain/automation.types.js'
import type { LumiSchedule } from '../../src/modules/lumi/automation/domain/schedule.js'
import { AutomationScheduler, type SchedulerOptions } from '../../src/modules/lumi/automation/services/automation-scheduler.js'
import { AutomationWorker, type NotificationSink } from '../../src/modules/lumi/automation/services/automation-worker.js'

/** Store en memoria que cumple el puerto AutomationStore (operaciones usadas por scheduler y worker). */
class MemoryStore {
  tasks = new Map<string, LumiTask>()
  executions = new Map<string, LumiExecution>()
  private seq = 0

  addTask(input: { schedule: LumiSchedule; nextRunAt: Date | null; status?: LumiTask['status']; userId?: string }): LumiTask {
    const now = new Date(0)
    const task: LumiTask = {
      id: `t${++this.seq}`,
      userId: input.userId ?? 'u1',
      title: 'Revisar iniciativas',
      description: null,
      kind: 'routine',
      status: input.status ?? 'active',
      schedule: input.schedule,
      nextRunAt: input.nextRunAt,
      lastRunAt: null,
      parentTaskId: null,
      createdAt: now,
      updatedAt: now,
    }
    this.tasks.set(task.id, task)
    return task
  }

  async findTask(id: string) {
    return this.tasks.get(id) ?? null
  }

  async findDueTasks(now: Date, limit: number) {
    return [...this.tasks.values()]
      .filter((t) => t.status === 'active' && t.nextRunAt && t.nextRunAt.getTime() <= now.getTime())
      .sort((a, b) => a.nextRunAt!.getTime() - b.nextRunAt!.getTime())
      .slice(0, limit)
  }

  async insertExecution(e: NewExecution) {
    if ([...this.executions.values()].some((x) => x.occurrenceKey === e.occurrenceKey)) return false
    const id = `e${++this.seq}`
    this.executions.set(id, {
      id,
      ...e,
      status: 'pending',
      attempts: 0,
      lockedAt: null,
      startedAt: null,
      finishedAt: null,
      error: null,
      result: null,
    })
    return true
  }

  async claimExecution(now: Date, maxAttempts: number) {
    const candidates = [...this.executions.values()]
      .filter(
        (e) =>
          e.nextAttemptAt.getTime() <= now.getTime() &&
          (e.status === 'pending' || (e.status === 'failed' && e.attempts < maxAttempts)),
      )
      .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime())
    const found = candidates[0]
    if (!found) return null
    Object.assign(found, { status: 'running' as ExecutionStatus, lockedAt: now, startedAt: now, attempts: found.attempts + 1 })
    return { ...found }
  }

  async updateExecution(id: string, patch: Partial<LumiExecution> & { status: ExecutionStatus }) {
    Object.assign(this.executions.get(id)!, patch)
  }

  async recoverStaleExecutions(staleBefore: Date, now: Date) {
    let n = 0
    for (const e of this.executions.values()) {
      if (e.status === 'running' && e.lockedAt && e.lockedAt.getTime() < staleBefore.getTime()) {
        Object.assign(e, { status: 'failed', lockedAt: null, nextAttemptAt: now, error: 'Interrumpida' })
        n += 1
      }
    }
    return n
  }

  async updateTaskIf(
    id: string,
    expected: { status?: LumiTask['status'] | LumiTask['status'][]; nextRunAt?: Date },
    patch: TaskPatch,
  ) {
    const task = this.tasks.get(id)
    if (!task) return false
    if (expected.status !== undefined) {
      const allowed = Array.isArray(expected.status) ? expected.status : [expected.status]
      if (!allowed.includes(task.status)) return false
    }
    if (expected.nextRunAt !== undefined && task.nextRunAt?.getTime() !== expected.nextRunAt.getTime()) return false
    Object.assign(task, patch)
    return true
  }

  executionsFor(taskId: string) {
    return [...this.executions.values()].filter((e) => e.taskId === taskId)
  }
}

function setup(opts: Partial<SchedulerOptions> = {}) {
  let now = new Date('2026-11-13T12:00:00.000Z')
  const clock = () => now
  const store = new MemoryStore()
  const sent: Array<{ userId: string; title: string }> = []
  const sink: NotificationSink & { failures: number } = {
    failures: 0,
    async notify(input) {
      if (this.failures > 0) {
        this.failures -= 1
        throw new Error('canal caído')
      }
      sent.push({ userId: input.userId, title: input.title })
    },
  }
  const lock = { held: false, async tryAcquire() { if (this.held) return false; return true }, async release() {} }
  const worker = new AutomationWorker(store as unknown as AutomationStore, sink, {
    handlerTimeoutMs: 1000,
    maxAttempts: 3,
    now: clock,
  })
  const scheduler = new AutomationScheduler(
    store as unknown as AutomationStore,
    lock as unknown as AutomationLock,
    worker,
    {
      tickMs: 30_000,
      lockTtlMs: 25_000,
      maxExecutionsPerTick: 5,
      dueBatchSize: 50,
      staleAfterMs: 5 * 60_000,
      maxAttempts: 3,
      ...opts,
    },
    clock,
  )
  return {
    store,
    sink,
    sent,
    lock,
    scheduler,
    setNow(value: string) {
      now = new Date(value)
    },
  }
}

// 08:00 Bogotá = 13:00 UTC
const DAILY_8AM = { type: 'daily' as const, time: '08:00', timezone: 'America/Bogota' }

describe('lumi automation — scheduler y worker (sin Qwen)', () => {
  it('ejecuta una rutina diaria y avanza a la siguiente ocurrencia', async () => {
    const t = setup()
    const task = t.store.addTask({ schedule: DAILY_8AM, nextRunAt: new Date('2026-11-13T13:00:00.000Z') })
    t.setNow('2026-11-13T13:00:30.000Z')

    const summary = await t.scheduler.tick()

    expect(summary.enqueued).toBe(1)
    expect(summary.executed).toBe(1)
    expect(t.sent).toEqual([{ userId: 'u1', title: 'Revisar iniciativas' }])
    expect(t.store.tasks.get(task.id)!.nextRunAt!.toISOString()).toBe('2026-11-14T13:00:00.000Z')
    expect(t.store.executionsFor(task.id)[0]!.status).toBe('succeeded')
  })

  it('no duplica la ocurrencia si el tick se repite o la tarea ya avanzó', async () => {
    const t = setup()
    const task = t.store.addTask({ schedule: DAILY_8AM, nextRunAt: new Date('2026-11-13T13:00:00.000Z') })
    t.setNow('2026-11-13T13:00:30.000Z')
    await t.scheduler.tick()
    await t.scheduler.tick()
    await t.scheduler.tick()
    expect(t.store.executionsFor(task.id)).toHaveLength(1)
    expect(t.sent).toHaveLength(1)
  })

  it('tras un reinicio a mitad de proceso no repite la ocurrencia ya registrada', async () => {
    const t = setup()
    const task = t.store.addTask({ schedule: DAILY_8AM, nextRunAt: new Date('2026-11-13T13:00:00.000Z') })
    // Simula: la ejecución se creó, pero la tarea no llegó a avanzar antes del corte.
    await t.store.insertExecution({
      occurrenceKey: `${task.id}|2026-11-13T13:00:00.000Z`,
      taskId: task.id,
      userId: 'u1',
      scheduledFor: new Date('2026-11-13T13:00:00.000Z'),
      nextAttemptAt: new Date('2026-11-13T13:00:00.000Z'),
      createdAt: new Date('2026-11-13T13:00:00.000Z'),
    })
    t.setNow('2026-11-13T13:05:00.000Z')
    await t.scheduler.tick()
    expect(t.store.executionsFor(task.id)).toHaveLength(1)
    expect(t.store.tasks.get(task.id)!.nextRunAt!.toISOString()).toBe('2026-11-14T13:00:00.000Z')
  })

  it('tras estar apagado varios días genera una sola ejecución de recuperación', async () => {
    const t = setup()
    const task = t.store.addTask({ schedule: DAILY_8AM, nextRunAt: new Date('2026-11-10T13:00:00.000Z') })
    t.setNow('2026-11-13T15:00:00.000Z')
    await t.scheduler.tick()
    expect(t.store.executionsFor(task.id)).toHaveLength(1)
    expect(t.store.tasks.get(task.id)!.nextRunAt!.toISOString()).toBe('2026-11-14T13:00:00.000Z')
  })

  it('una tarea puntual se ejecuta una vez y queda completada', async () => {
    const t = setup()
    const runAt = new Date('2026-11-13T12:30:00.000Z')
    const task = t.store.addTask({ schedule: { type: 'once', runAt }, nextRunAt: runAt })
    t.setNow('2026-11-13T12:31:00.000Z')
    await t.scheduler.tick()
    expect(t.sent).toHaveLength(1)
    expect(t.store.tasks.get(task.id)!.status).toBe('completed')
    expect(t.store.tasks.get(task.id)!.nextRunAt).toBeNull()
  })

  it('una tarea pausada no se ejecuta', async () => {
    const t = setup()
    const task = t.store.addTask({ schedule: DAILY_8AM, nextRunAt: new Date('2026-11-13T13:00:00.000Z'), status: 'paused' })
    t.setNow('2026-11-13T13:00:30.000Z')
    await t.scheduler.tick()
    expect(t.store.executionsFor(task.id)).toHaveLength(0)
    expect(t.sent).toHaveLength(0)
  })

  it('una ejecución encolada se omite si la tarea se pausa antes de correr', async () => {
    const t = setup()
    const task = t.store.addTask({ schedule: DAILY_8AM, nextRunAt: new Date('2026-11-13T13:00:00.000Z') })
    t.setNow('2026-11-13T13:00:30.000Z')
    await t.scheduler.tick()
    // Ya hay una ejecución pendiente de reintento; el usuario pausa la tarea antes del reintento.
    const exec = t.store.executionsFor(task.id)[0]!
    Object.assign(exec, { status: 'pending' })
    t.store.tasks.get(task.id)!.status = 'paused'
    const worker = new AutomationWorker(t.store as unknown as AutomationStore, t.sink, {
      handlerTimeoutMs: 1000,
      maxAttempts: 3,
      now: () => new Date(),
    })
    await worker.execute({ ...exec, attempts: 1 })
    expect(exec.status).toBe('skipped')
    expect(t.sent).toHaveLength(1) // solo la del tick original
  })

  it('reintenta con backoff tras un fallo y marca dead al agotar intentos', async () => {
    const t = setup()
    const task = t.store.addTask({ schedule: DAILY_8AM, nextRunAt: new Date('2026-11-13T13:00:00.000Z') })
    t.sink.failures = 3
    t.setNow('2026-11-13T13:00:30.000Z')
    await t.scheduler.tick() // intento 1 → failed, reintento en 1 min
    expect(t.store.executionsFor(task.id)[0]!.status).toBe('failed')

    t.setNow('2026-11-13T13:00:40.000Z')
    expect((await t.scheduler.tick()).executed).toBe(0) // aún no toca el reintento

    t.setNow('2026-11-13T13:01:31.000Z')
    await t.scheduler.tick() // intento 2 → failed, reintento en 2 min
    t.setNow('2026-11-13T13:03:40.000Z')
    await t.scheduler.tick() // intento 3 → dead
    const exec = t.store.executionsFor(task.id)[0]!
    expect(exec.status).toBe('dead')
    expect(exec.attempts).toBe(3)
    expect(t.sent).toHaveLength(0)
  })

  it('recupera ejecuciones interrumpidas por reinicio y las completa', async () => {
    const t = setup()
    const task = t.store.addTask({ schedule: DAILY_8AM, nextRunAt: null })
    const stuck = await t.store.insertExecution({
      occurrenceKey: `${task.id}|x`,
      taskId: task.id,
      userId: 'u1',
      scheduledFor: new Date('2026-11-13T13:00:00.000Z'),
      nextAttemptAt: new Date('2026-11-13T13:00:00.000Z'),
      createdAt: new Date('2026-11-13T13:00:00.000Z'),
    })
    expect(stuck).toBe(true)
    const exec = t.store.executionsFor(task.id)[0]!
    Object.assign(exec, { status: 'running', lockedAt: new Date('2026-11-13T11:00:00.000Z'), attempts: 1 })

    const summary = await t.scheduler.tick()
    expect(summary.recovered).toBe(1)
    expect(summary.executed).toBe(1)
    expect(exec.status).toBe('succeeded')
    expect(t.sent).toHaveLength(1)
  })

  it('si otra instancia tiene el lock, el tick no ejecuta nada', async () => {
    const t = setup()
    const task = t.store.addTask({ schedule: DAILY_8AM, nextRunAt: new Date('2026-11-13T13:00:00.000Z') })
    t.lock.held = true
    t.setNow('2026-11-13T13:00:30.000Z')
    const summary = await t.scheduler.tick()
    expect(summary.skippedLock).toBe(true)
    expect(t.store.executionsFor(task.id)).toHaveLength(0)
  })

  it('respeta el máximo de ejecuciones por tick', async () => {
    const t = setup({ maxExecutionsPerTick: 2 })
    for (let i = 0; i < 4; i += 1) {
      t.store.addTask({ schedule: { type: 'once', runAt: new Date('2026-11-13T12:30:00.000Z') }, nextRunAt: new Date('2026-11-13T12:30:00.000Z') })
    }
    t.setNow('2026-11-13T12:31:00.000Z')
    const first = await t.scheduler.tick()
    expect(first.executed).toBe(2)
    expect(t.sent).toHaveLength(2)
  })
})

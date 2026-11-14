import { describe, expect, it } from 'vitest'
import type { NotificationRepository } from '../../src/modules/notifications/infrastructure/notification.repository.js'
import { NotificationStreamHub } from '../../src/modules/notifications/services/notification-stream.hub.js'
import { RepositoryNotificationSink } from '../../src/modules/lumi/automation/infrastructure/automation-adapters.js'

describe('canal en tiempo real de notificaciones', () => {
  it('entrega solo al usuario destinatario y deja de enviar al cancelar la suscripción', () => {
    const hub = new NotificationStreamHub()
    const a: unknown[] = []
    const b: unknown[] = []
    const unsubscribeA = hub.subscribe('u1', (_e, data) => a.push(data))
    hub.subscribe('u2', (_e, data) => b.push(data))
    expect(hub.connections).toBe(2)

    hub.publish('u1', { id: 1 })
    expect(a).toEqual([{ id: 1 }])
    expect(b).toEqual([])

    unsubscribeA()
    hub.publish('u1', { id: 2 })
    expect(a).toHaveLength(1)
    expect(hub.connections).toBe(1)
  })

  it('una conexión que falla no impide entregar a las demás', () => {
    const hub = new NotificationStreamHub()
    const ok: unknown[] = []
    hub.subscribe('u1', () => {
      throw new Error('socket cerrado')
    })
    hub.subscribe('u1', (_e, data) => ok.push(data))
    hub.publish('u1', { id: 3 })
    expect(ok).toEqual([{ id: 3 }])
  })
})

describe('notificaciones del motor: deduplicación', () => {
  const input = {
    userId: 'u1',
    title: 'Revisar iniciativas pendientes',
    message: 'Revisa tus iniciativas',
    data: { taskId: 't1', executionId: 'e1', kind: 'routine' },
  }

  it('guarda, publica en tiempo real y no duplica si la misma ocurrencia llega dos veces', async () => {
    const stored: Array<Record<string, unknown>> = []
    const repo = {
      async insertOne(doc: Record<string, unknown>) {
        // Simula el índice único (userId, dedupKey)
        if (stored.some((d) => d.dedupKey === doc.dedupKey)) {
          throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 })
        }
        stored.push(doc)
        return 'n1'
      },
    } as unknown as NotificationRepository

    const published: unknown[] = []
    const hub = new NotificationStreamHub()
    hub.subscribe('u1', (_e, data) => published.push(data))

    const sink = new RepositoryNotificationSink(repo, hub)
    await sink.notify(input)
    await sink.notify(input)

    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ type: 'lumi_automation', dedupKey: 'e1', reviewed: false, read: false })
    expect(published).toHaveLength(1)
    expect(published[0]).toMatchObject({ id: 'n1', title: 'Revisar iniciativas pendientes' })
  })

  it('propaga errores que no son de duplicado', async () => {
    const repo = {
      async insertOne() {
        throw new Error('Mongo caído')
      },
    } as unknown as NotificationRepository
    await expect(new RepositoryNotificationSink(repo).notify(input)).rejects.toThrow('Mongo caído')
  })
})

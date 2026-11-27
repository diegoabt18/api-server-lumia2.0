import { describe, expect, it } from 'vitest'
import { assertProductionRequirements, type Env } from '../../src/config/env.js'
import {
  NotificationStreamHub,
  type NotificationBus,
} from '../../src/modules/notifications/services/notification-stream.hub.js'

const env = (over: Partial<Env>) =>
  ({ NODE_ENV: 'production', REDIS_ENABLED: true, REDIS_URL: 'redis://r:6379', ...over }) as Env

describe('Redis obligatorio en producción', () => {
  it('en producción exige REDIS_URL y REDIS_ENABLED', () => {
    expect(() => assertProductionRequirements(env({}))).not.toThrow()
    expect(() => assertProductionRequirements(env({ REDIS_URL: undefined }))).toThrow(
      /Redis is required/,
    )
    expect(() => assertProductionRequirements(env({ REDIS_ENABLED: false }))).toThrow(
      /Redis is required/,
    )
  })

  it('en desarrollo y pruebas sigue siendo opcional', () => {
    for (const NODE_ENV of ['development', 'test'] as const) {
      expect(() =>
        assertProductionRequirements(env({ NODE_ENV, REDIS_URL: undefined, REDIS_ENABLED: false })),
      ).not.toThrow()
    }
  })
})

/** Bus compartido en memoria: simula Redis pub/sub entre dos instancias del servidor. */
function sharedBus() {
  const listeners: Array<(userId: string, payload: unknown) => void> = []
  let failing = false
  const make = (): NotificationBus => ({
    async publish(userId, payload) {
      if (failing) throw new Error('redis down')
      for (const deliver of listeners) deliver(userId, payload)
    },
    onMessage(deliver) {
      listeners.push(deliver)
    },
    async close() {},
  })
  return { make, fail: (v: boolean) => (failing = v) }
}

describe('notificaciones en tiempo real entre instancias', () => {
  it('una notificación publicada en una instancia llega a las conexiones de la otra', async () => {
    const bus = sharedBus()
    const a = new NotificationStreamHub(bus.make())
    const b = new NotificationStreamHub(bus.make())
    const received: unknown[] = []
    b.subscribe('u1', (_event, data) => received.push(data))
    a.subscribe('u2', () => received.push('wrong user'))
    a.publish('u1', { id: 'n1' })
    await Promise.resolve()
    expect(received).toEqual([{ id: 'n1' }])
  })

  it('si el bus falla, la instancia entrega a sus propias conexiones y avisa del error', async () => {
    const bus = sharedBus()
    const errors: unknown[] = []
    const a = new NotificationStreamHub(bus.make(), (err) => errors.push(err))
    const received: unknown[] = []
    a.subscribe('u1', (_event, data) => received.push(data))
    bus.fail(true)
    a.publish('u1', { id: 'n2' })
    await new Promise((r) => setTimeout(r, 0))
    expect(received).toEqual([{ id: 'n2' }])
    expect(errors).toHaveLength(1)
  })

  it('sin bus entrega solo en la instancia, como antes', () => {
    const hub = new NotificationStreamHub()
    const received: unknown[] = []
    const off = hub.subscribe('u1', (_e, d) => received.push(d))
    hub.publish('u1', 1)
    off()
    hub.publish('u1', 2)
    expect(received).toEqual([1])
    expect(hub.connections).toBe(0)
  })
})

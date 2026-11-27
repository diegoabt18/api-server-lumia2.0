/**
 * Bus de notificaciones contra Redis real. Solo se ejecuta si REDIS_TEST_URL está definida:
 *   REDIS_TEST_URL=redis://127.0.0.1:6379 npm run test:integration
 */
import { Redis } from 'ioredis'
import { afterAll, describe, expect, it } from 'vitest'
import { RedisNotificationBus } from '../../src/modules/notifications/infrastructure/redis-notification-bus.js'
import { NotificationStreamHub } from '../../src/modules/notifications/services/notification-stream.hub.js'

const url = process.env.REDIS_TEST_URL
const describeIfRedis = url ? describe : describe.skip
const logger = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } as never

describeIfRedis('notificaciones entre dos instancias con Redis real', () => {
  const clients: Redis[] = []
  const hubs: NotificationStreamHub[] = []

  afterAll(async () => {
    for (const hub of hubs) await hub.close()
    for (const client of clients) await client.quit()
  })

  it('lo publicado por una instancia llega a la otra', async () => {
    const instance = async () => {
      const client = new Redis(url!, { lazyConnect: true })
      await client.connect()
      clients.push(client)
      const hub = new NotificationStreamHub(await RedisNotificationBus.create(client, logger))
      hubs.push(hub)
      return hub
    }
    const a = await instance()
    const b = await instance()
    const received = new Promise((resolve) => b.subscribe('u1', (_e, data) => resolve(data)))
    a.publish('u1', { id: 'n1' })
    await expect(received).resolves.toEqual({ id: 'n1' })
  })
})

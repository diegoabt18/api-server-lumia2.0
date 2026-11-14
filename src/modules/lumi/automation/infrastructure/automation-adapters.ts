import { ObjectId } from 'mongodb'
import type { RedisClient } from '../../../../database/connections/redis.manager.js'
import type { NotificationRepository } from '../../../notifications/infrastructure/notification.repository.js'
import type { AutomationLock } from '../domain/automation.store.js'
import type { NotificationSink } from '../services/automation-worker.js'
import type { NotificationStreamHub } from '../../../notifications/services/notification-stream.hub.js'

/**
 * Lock con Redis (SET NX PX). Sin Redis, solo es seguro con una instancia del servidor: se
 * permite ejecutar y se deja constancia en el log del arranque.
 */
export class RedisAutomationLock implements AutomationLock {
  private readonly token = `${process.pid}-${Math.random().toString(36).slice(2)}`

  constructor(private readonly redis: RedisClient) {}

  async tryAcquire(key: string, ttlMs: number): Promise<boolean> {
    if (!this.redis) return true
    const result = await this.redis.set(key, this.token, 'PX', ttlMs, 'NX')
    return result === 'OK'
  }

  async release(key: string): Promise<void> {
    if (!this.redis) return
    // Solo libera si el lock sigue siendo nuestro (evita borrar el de otra instancia tras expirar).
    await this.redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      key,
      this.token,
    )
  }
}

/** Sin Redis no hay bloqueo entre procesos: el lock siempre se concede. */
export class LocalAutomationLock implements AutomationLock {
  async tryAcquire(): Promise<boolean> {
    return true
  }
  async release(): Promise<void> {}
}

/** Notificaciones del motor: se guardan en la colección existente, que alimenta el centro global. */
export class RepositoryNotificationSink implements NotificationSink {
  constructor(
    private readonly notifications: NotificationRepository,
    private readonly hub?: NotificationStreamHub,
  ) {}

  async notify(input: {
    userId: string
    title: string
    message: string
    data: Record<string, string>
  }): Promise<void> {
    const createdAt = new Date()
    const dedupKey = input.data.executionId
    try {
      const id = await this.notifications.insertOne({
        _id: new ObjectId(),
        userId: input.userId,
        type: 'lumi_automation',
        title: input.title,
        message: input.message,
        read: false,
        reviewed: false,
        createdAt,
        data: input.data,
        ...(dedupKey ? { dedupKey } : {}),
      })
      this.hub?.publish(input.userId, {
        id,
        type: 'lumi_automation',
        title: input.title,
        message: input.message,
        read: false,
        reviewed: false,
        createdAt: createdAt.toISOString(),
        data: input.data,
      })
    } catch (err) {
      // Índice único (userId, dedupKey): la ocurrencia ya fue notificada.
      if ((err as { code?: unknown }).code === 11000) return
      throw err
    }
  }
}

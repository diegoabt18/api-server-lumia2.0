import type { Redis } from 'ioredis'
import type { AppLogger } from '../../../config/logger.js'
import type { NotificationBus } from '../services/notification-stream.hub.js'

const CHANNEL = 'lumia:notifications:stream'

/**
 * Reparto de notificaciones en tiempo real entre instancias del servidor: cada instancia publica en
 * Redis y todas entregan a sus propias conexiones SSE. Usa una conexión dedicada para suscribirse
 * (una conexión en modo suscripción no admite otros comandos).
 */
export class RedisNotificationBus implements NotificationBus {
  private constructor(
    private readonly publisher: Redis,
    private readonly subscriber: Redis,
    private readonly logger: AppLogger,
  ) {}

  static async create(client: Redis, logger: AppLogger): Promise<RedisNotificationBus> {
    const subscriber = client.duplicate()
    subscriber.on('error', () => {
      /* los errores se ven en los comandos; ioredis reconecta solo */
    })
    await subscriber.connect()
    await subscriber.subscribe(CHANNEL)
    return new RedisNotificationBus(client, subscriber, logger)
  }

  async publish(userId: string, payload: unknown): Promise<void> {
    await this.publisher.publish(CHANNEL, JSON.stringify({ userId, payload }))
  }

  onMessage(deliver: (userId: string, payload: unknown) => void): void {
    this.subscriber.on('message', (channel: string, raw: string) => {
      if (channel !== CHANNEL) return
      try {
        const message = JSON.parse(raw) as { userId?: unknown; payload?: unknown }
        if (typeof message.userId === 'string') deliver(message.userId, message.payload)
      } catch (err) {
        this.logger.warn({ err }, 'Malformed notification stream message')
      }
    })
  }

  async close(): Promise<void> {
    await this.subscriber.quit().catch(() => {})
  }
}

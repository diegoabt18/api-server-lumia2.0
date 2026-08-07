import { cert, getApps, initializeApp } from 'firebase-admin/app'
import { getMessaging, type MulticastMessage } from 'firebase-admin/messaging'
import type { AppLogger } from '../../../config/logger.js'
import type { OrderDomain } from '../../sales/domain/order.entity.js'
import type { PushDeviceRepository } from '../infrastructure/push-device.repository.js'

export interface PushConfig {
  enabled: boolean
  projectId?: string
  clientEmail?: string
  privateKey?: string
}

function formatCop(amount: number): string {
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: 'COP',
    maximumFractionDigits: 0,
  }).format(amount)
}

export class PushService {
  private initialized = false

  constructor(
    private readonly config: PushConfig,
    private readonly devices: PushDeviceRepository,
    private readonly logger?: AppLogger,
  ) {}

  private isReady(): boolean {
    return Boolean(
      this.config.enabled &&
        this.config.projectId &&
        this.config.clientEmail &&
        this.config.privateKey,
    )
  }

  private ensureFirebase(): boolean {
    if (!this.isReady()) return false
    if (this.initialized) return true

    try {
      const privateKey = this.config.privateKey!.replace(/\\n/g, '\n')
      if (!getApps().length) {
        initializeApp({
          credential: cert({
            projectId: this.config.projectId!,
            clientEmail: this.config.clientEmail!,
            privateKey,
          }),
        })
      }
      this.initialized = true
      return true
    } catch (err) {
      this.logger?.error({ err }, 'Failed to initialize Firebase Admin')
      return false
    }
  }

  async registerDevice(input: {
    fcmToken: string
    platform: 'android' | 'ios'
    deviceLabel?: string
  }): Promise<void> {
    await this.devices.upsertDevice(input)
    this.logger?.info(
      { platform: input.platform, deviceLabel: input.deviceLabel },
      'Push device registered',
    )
  }

  async unregisterDevice(fcmToken: string): Promise<boolean> {
    return this.devices.deactivateToken(fcmToken)
  }

  /** Notificación push a todos los dispositivos LumiChat activos. */
  async notifyPreOrderCreated(order: OrderDomain): Promise<void> {
    if (!this.ensureFirebase()) {
      this.logger?.debug('Pre-order push skipped: FCM not configured')
      return
    }

    const tokens = await this.devices.listActiveTokens()
    if (!tokens.length) {
      this.logger?.debug('Pre-order push skipped: no registered devices')
      return
    }

    const itemCount = order.items.reduce((sum, i) => sum + i.quantity, 0)
    const orderNumber = order.orderNumber ?? order.id
    const title = 'Nuevo pedido'
    const body = `${orderNumber} · ${formatCop(order.total)} · ${itemCount} artículo${itemCount === 1 ? '' : 's'}`

    const message: MulticastMessage = {
      tokens,
      notification: { title, body },
      data: {
        type: 'order.created',
        orderId: order.id,
        orderNumber,
        total: String(order.total),
        itemCount: String(itemCount),
        customerName: order.customerName ?? '',
      },
      android: {
        priority: 'high',
        notification: {
          channelId: 'orders',
          priority: 'high' as const,
        },
      },
    }

    try {
      const res = await getMessaging().sendEachForMulticast(message)
      this.logger?.info(
        {
          orderId: order.id,
          orderNumber: order.orderNumber,
          success: res.successCount,
          failure: res.failureCount,
        },
        'Pre-order push notification sent',
      )

      const invalidTokens: string[] = []
      res.responses.forEach((r: { success: boolean; error?: { code?: string } }, i: number) => {
        if (r.success) return
        const code = r.error?.code
        if (
          code === 'messaging/invalid-registration-token' ||
          code === 'messaging/registration-token-not-registered'
        ) {
          invalidTokens.push(tokens[i]!)
        }
      })

      if (invalidTokens.length) {
        await this.devices.deactivateTokens(invalidTokens)
        this.logger?.info({ count: invalidTokens.length }, 'Deactivated invalid FCM tokens')
      }
    } catch (err) {
      this.logger?.error(
        { err, orderId: order.id, orderNumber: order.orderNumber },
        'Failed to send pre-order push notification',
      )
    }
  }
}

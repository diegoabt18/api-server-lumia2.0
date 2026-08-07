import nodemailer from 'nodemailer'
import type { Transporter } from 'nodemailer'
import type { AppLogger } from '../../../config/logger.js'
import type { OrderDomain } from '../../sales/domain/order.entity.js'
import { buildPreOrderNotification } from '../templates/pre-order-notification.template.js'

export interface MailConfig {
  enabled: boolean
  smtpHost?: string
  smtpPort: number
  smtpSecure: boolean
  smtpUser?: string
  smtpPass?: string
  mailFrom: string
  salesNotifyEmail: string
}

export class MailService {
  private transporter: Transporter | null = null

  constructor(
    private readonly config: MailConfig,
    private readonly logger?: AppLogger,
  ) {}

  private isReady(): boolean {
    return this.config.enabled && Boolean(this.config.smtpHost && this.config.salesNotifyEmail)
  }

  private getTransporter(): Transporter {
    if (!this.transporter) {
      this.transporter = nodemailer.createTransport({
        host: this.config.smtpHost,
        port: this.config.smtpPort,
        secure: this.config.smtpSecure,
        auth:
          this.config.smtpUser && this.config.smtpPass
            ? { user: this.config.smtpUser, pass: this.config.smtpPass }
            : undefined,
      })
    }
    return this.transporter
  }

  /** Notificación interna a ventas — no envía correo al cliente. */
  async notifyPreOrderCreated(order: OrderDomain): Promise<void> {
    if (!this.isReady()) {
      this.logger?.debug('Pre-order mail skipped: SMTP not configured')
      return
    }

    const { subject, text, html } = buildPreOrderNotification(order)

    try {
      await this.getTransporter().sendMail({
        from: this.config.mailFrom,
        to: this.config.salesNotifyEmail,
        subject,
        text,
        html,
      })
      this.logger?.info(
        { orderId: order.id, orderNumber: order.orderNumber, to: this.config.salesNotifyEmail },
        'Pre-order notification email sent',
      )
    } catch (err) {
      this.logger?.error(
        { err, orderId: order.id, orderNumber: order.orderNumber },
        'Failed to send pre-order notification email',
      )
    }
  }
}

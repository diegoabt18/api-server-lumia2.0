import type { NotificationRepository } from '../infrastructure/notification.repository.js'

export class NotificationService {
  constructor(private readonly notifications: NotificationRepository) {}

  async list(userId: string, page: number, limit: number) {
    const list = await this.notifications.listByUser(userId, page, limit)
    const unreadCount = await this.notifications.countUnread(userId)
    return { items: list.items, unreadCount, pagination: list.pagination }
  }

  async unreadCount(userId: string) {
    const count = await this.notifications.countUnread(userId)
    return { unreadCount: count }
  }

  async markRead(userId: string, ids: string[]) {
    const modified = await this.notifications.markRead(userId, ids)
    const unreadCount = await this.notifications.countUnread(userId)
    return { ok: true, modified, unreadCount }
  }

  async markAllRead(userId: string) {
    const modified = await this.notifications.markAllRead(userId)
    const unreadCount = await this.notifications.countUnread(userId)
    return { ok: true, modified, unreadCount }
  }

  async delete(userId: string, id: string) {
    const ok = await this.notifications.deleteOne(userId, id)
    if (!ok) throw new Error('NOT_FOUND')
    const unreadCount = await this.notifications.countUnread(userId)
    return { ok: true, unreadCount }
  }
}

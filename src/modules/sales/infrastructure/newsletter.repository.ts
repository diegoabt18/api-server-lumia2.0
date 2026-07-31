import type { Db } from 'mongodb'
import { getCollection } from '../../../database/repositories/base.repository.js'

export class NewsletterRepository {
  private readonly collection

  constructor(db: Db) {
    this.collection = getCollection<{ email: string; subscribedAt: Date }>(db, 'newsletter_subscribers')
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndexes([{ key: { email: 1 }, unique: true }])
  }

  async subscribe(email: string): Promise<void> {
    const normalized = email.toLowerCase().trim()
    await this.collection.updateOne(
      { email: normalized },
      { $set: { email: normalized, subscribedAt: new Date() } },
      { upsert: true },
    )
  }
}

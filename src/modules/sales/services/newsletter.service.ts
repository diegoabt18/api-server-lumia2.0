import type { NewsletterRepository } from '../infrastructure/newsletter.repository.js'

export class NewsletterService {
  constructor(private readonly newsletter: NewsletterRepository) {}

  async subscribe(email: string) {
    await this.newsletter.subscribe(email)
    return { ok: true }
  }
}

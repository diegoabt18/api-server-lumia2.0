import { AppError } from '../../../common/errors/app.error.js'
import type { FavoritesRepository } from '../infrastructure/favorites.repository.js'

export class FavoritesService {
  constructor(private readonly favorites: FavoritesRepository) {}

  async list(userId: string) {
    const slugs = await this.favorites.listSlugs(userId)
    return { slugs }
  }

  async sync(userId: string, slugs: string[]) {
    const merged = await this.favorites.mergeSlugs(userId, slugs.slice(0, 30))
    return { slugs: merged }
  }

  async toggle(userId: string, productSlug: string) {
    try {
      const favorited = await this.favorites.toggle(userId, productSlug)
      return { favorited }
    } catch {
      throw AppError.conflict('Límite de favoritos alcanzado')
    }
  }
}

import type { UserRepository } from '../../identity/infrastructure/user.repository.js'
import type { SessionRepository } from '../../identity/infrastructure/session.repository.js'
import type { ProductRepository } from '../../catalog/infrastructure/product.repository.js'
import type { PromotionRepository } from '../../catalog/infrastructure/promotion.repository.js'
import type { OrderRepository } from '../../sales/infrastructure/order.repository.js'
import type { FavoritesRepository } from '../../sales/infrastructure/favorites.repository.js'

export class DashboardService {
  constructor(
    private readonly users: UserRepository,
    private readonly sessions: SessionRepository,
    private readonly products: ProductRepository,
    private readonly orders: OrderRepository,
    private readonly promotions: PromotionRepository,
    private readonly favorites: FavoritesRepository,
  ) {}

  async getStats() {
    const now = new Date()
    const soon72h = new Date(now.getTime() + 72 * 60 * 60 * 1000)

    const [
      staffCount,
      productCount,
      activeProductCount,
      orderCount,
      totalSales,
      activeSessions,
      activePromotions,
      usersWithFavorites,
      topSelling,
      topPopular,
      promotionsExpiringSoon,
      outOfStockProducts,
      emptyCategories,
      topFavoritedRaw,
    ] = await Promise.all([
      this.users.countStaff(),
      this.products.countAllAdmin(),
      this.products.countActiveAdmin(),
      this.orders.countAllAdmin(),
      this.orders.sumPaidTotal(),
      this.sessions.countActive(),
      this.promotions.countActiveAt(now),
      this.favorites.countDistinctUsers(now),
      this.products.findTopSelling(6),
      this.products.findTopPopular(6),
      this.promotions.findExpiringSoon(now, soon72h, 8),
      this.products.findOutOfStock(8),
      this.products.findEmptyCategories(8),
      this.favorites.topProductSlugs(6),
    ])

    const topFavorited = await this.products.enrichFavoriteSlugs(topFavoritedRaw)

    return {
      staffCount,
      productCount,
      activeProductCount,
      orderCount,
      totalSales,
      activeSessions,
      activePromotions,
      usersWithFavorites,
      top: {
        selling: topSelling,
        popular: topPopular,
        favorited: topFavorited,
      },
      alerts: {
        promotionsExpiringSoon,
        outOfStockProducts,
        emptyCategories,
      },
    }
  }
}

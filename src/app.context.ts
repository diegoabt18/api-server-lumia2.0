import type { Env } from './config/env.js'
import type { AppLogger } from './config/logger.js'
import { MongoConnectionManager } from './database/connections/mongo.manager.js'
import { RedisManager, CacheService } from './database/connections/redis.manager.js'
import { UserRepository } from './modules/identity/infrastructure/user.repository.js'
import { SessionRepository } from './modules/identity/infrastructure/session.repository.js'
import { JwtTokenService } from './modules/identity/infrastructure/jwt.service.js'
import { AuthService } from './modules/identity/services/auth.service.js'
import { ProductRepository } from './modules/catalog/infrastructure/product.repository.js'
import { CategoryRepository } from './modules/catalog/infrastructure/category.repository.js'
import { ProductService } from './modules/catalog/services/product.service.js'
import { CategoryService } from './modules/catalog/services/category.service.js'
import { OrderRepository } from './modules/sales/infrastructure/order.repository.js'
import { OrderService } from './modules/sales/services/order.service.js'
import { CartRepository } from './modules/sales/infrastructure/cart.repository.js'
import { CartService } from './modules/sales/services/cart.service.js'
import { FavoritesRepository } from './modules/sales/infrastructure/favorites.repository.js'
import { FavoritesService } from './modules/sales/services/favorites.service.js'
import { ReviewRepository } from './modules/sales/infrastructure/review.repository.js'
import { FeedbackService } from './modules/sales/services/feedback.service.js'
import { NewsletterRepository } from './modules/sales/infrastructure/newsletter.repository.js'
import { NewsletterService } from './modules/sales/services/newsletter.service.js'
import { GoogleOAuthService } from './modules/identity/services/google-oauth.service.js'
import { InventoryRepository } from './modules/catalog/infrastructure/inventory.repository.js'
import { PaymentRepository } from './modules/payments/infrastructure/payment.repository.js'
import { ManualPaymentService } from './modules/payments/services/manual-payment.service.js'
import { PromotionRepository } from './modules/catalog/infrastructure/promotion.repository.js'
import { StoreBannerRepository } from './modules/catalog/infrastructure/store-banner.repository.js'
import { StoreSettingsRepository } from './modules/store/infrastructure/store-settings.repository.js'
import { StoreService } from './modules/store/services/store.service.js'
import { NotificationRepository } from './modules/notifications/infrastructure/notification.repository.js'
import { NotificationService } from './modules/notifications/services/notification.service.js'
import { DashboardService } from './modules/admin/services/dashboard.service.js'
import { AdminProductService } from './modules/admin/services/admin-product.service.js'
import { AdminOrderService } from './modules/admin/services/admin-order.service.js'
import { AdminCategoryService } from './modules/admin/services/admin-category.service.js'
import { AdminStoreService } from './modules/admin/services/admin-store.service.js'
import { AdminPromotionService } from './modules/admin/services/admin-promotion.service.js'
import { AdminBannerService } from './modules/admin/services/admin-banner.service.js'
import { AdminInventoryService } from './modules/admin/services/admin-inventory.service.js'
import { AdminStaffService } from './modules/admin/services/admin-staff.service.js'
import { AdminRegistryService } from './modules/admin/services/admin-registry.service.js'
import { AdminSessionService } from './modules/admin/services/admin-session.service.js'
import { AdminAnalyticsService } from './modules/admin/services/admin-analytics.service.js'
import { AdminFeedbackService } from './modules/admin/services/admin-feedback.service.js'
import { CatalogOptionRepository } from './modules/catalog/infrastructure/catalog-option.repository.js'
import { RegistryRepository } from './modules/admin/infrastructure/registry.repository.js'
import { FeedbackReportRepository } from './modules/sales/infrastructure/feedback-report.repository.js'
import { MaterialRepository } from './modules/production/infrastructure/material.repository.js'
import { SupplierRepository } from './modules/production/infrastructure/supplier.repository.js'
import { RecipeRepository } from './modules/production/infrastructure/recipe.repository.js'
import { ProductionConfigRepository } from './modules/production/infrastructure/production-config.repository.js'
import { ProductionAuditRepository } from './modules/production/infrastructure/production-audit.repository.js'
import { UnitRepository } from './modules/production/infrastructure/unit.repository.js'
import { UnitConversionService } from './modules/production/services/unit-conversion.service.js'
import { CostingService } from './modules/production/services/costing.service.js'
import { MaterialService } from './modules/production/services/material.service.js'
import { SupplierService } from './modules/production/services/supplier.service.js'
import { RecipeService } from './modules/production/services/recipe.service.js'
import { UnitService } from './modules/production/services/unit.service.js'
import { ProductionConfigService } from './modules/production/services/production-config.service.js'
import { ProductionAuditService, ProductionDashboardService } from './modules/production/services/dashboard.service.js'
import { AuthAuditRepository } from './modules/identity/infrastructure/auth-audit.repository.js'
import { TwoFactorRepository } from './modules/identity/infrastructure/two-factor.repository.js'
import { TwoFactorService } from './modules/identity/services/two-factor.service.js'
import { RoleRepository } from './modules/security/infrastructure/role.repository.js'
import { UserRoleRepository } from './modules/security/infrastructure/user-role.repository.js'
import { AuthorizationService } from './modules/security/services/authorization.service.js'
import { SecurityAdminService } from './modules/security/services/security-admin.service.js'

export interface AppContext {
  env: Env
  logger: AppLogger
  mongo: MongoConnectionManager
  redis: RedisManager
  cache: CacheService
  repos: {
    users: UserRepository
    sessions: SessionRepository
    products: ProductRepository
    categories: CategoryRepository
    orders: OrderRepository
    carts: CartRepository
    favorites: FavoritesRepository
    reviews: ReviewRepository
    newsletter: NewsletterRepository
    payments: PaymentRepository
    inventory: InventoryRepository
    promotions: PromotionRepository
    storeBanners: StoreBannerRepository
    storeSettings: StoreSettingsRepository
    notifications: NotificationRepository
    authAudit: AuthAuditRepository
    roles: RoleRepository
    userRoles: UserRoleRepository
    productionMaterials: MaterialRepository
    productionSuppliers: SupplierRepository
    productionRecipes: RecipeRepository
    productionConfig: ProductionConfigRepository
    productionAudit: ProductionAuditRepository
    productionUnits: UnitRepository
  }
  services: {
    auth: AuthService
    authorization: AuthorizationService
    twoFactor: TwoFactorService
    securityAdmin: SecurityAdminService
    products: ProductService
    categories: CategoryService
    orders: OrderService
    cart: CartService
    favorites: FavoritesService
    feedback: FeedbackService
    newsletter: NewsletterService
    googleOAuth: GoogleOAuthService
    manualPayments: ManualPaymentService
    store: StoreService
    notifications: NotificationService
    adminDashboard: DashboardService
    adminProducts: AdminProductService
    adminOrders: AdminOrderService
    adminCategories: AdminCategoryService
    adminStore: AdminStoreService
    adminPromotions: AdminPromotionService
    adminBanners: AdminBannerService
    adminInventory: AdminInventoryService
    adminStaff: AdminStaffService
    adminRegistry: AdminRegistryService
    adminSession: AdminSessionService
    adminAnalytics: AdminAnalyticsService
    adminFeedback: AdminFeedbackService
    productionMaterials: MaterialService
    productionSuppliers: SupplierService
    productionRecipes: RecipeService
    productionUnits: UnitService
    productionConfig: ProductionConfigService
    productionDashboard: ProductionDashboardService
    productionAudit: ProductionAuditService
    productionCosting: CostingService
  }
  jwt: JwtTokenService
}

export async function createAppContext(env: Env, logger: AppLogger): Promise<AppContext> {
  const mongo = new MongoConnectionManager(logger)
  const redisManager = new RedisManager(logger)
  const redisClient = await redisManager.connect()
  const cache = new CacheService(redisClient)

  const identityDb = await mongo.getDb('identity', env.MONGO_AUTH_URI)
  const catalogDb = await mongo.getDb('catalog', env.MONGO_CATALOG_URI)
  const salesDb = await mongo.getDb('sales', env.MONGO_SALES_URI)

  // production_db — Fase 5
  let productionDb = salesDb
  try {
    productionDb = await mongo.getDb('production', env.MONGO_PRODUCTION_URI)
  } catch (err) {
    logger.warn(
      { err },
      'production_db no disponible al arranque — repos de producción usarán sales_db como fallback',
    )
  }

  const users = new UserRepository(identityDb)
  const sessions = new SessionRepository(identityDb)
  const products = new ProductRepository(catalogDb)
  const categories = new CategoryRepository(catalogDb)
  const orders = new OrderRepository(salesDb)
  const carts = new CartRepository(salesDb)
  const favorites = new FavoritesRepository(salesDb)
  const reviews = new ReviewRepository(salesDb)
  const newsletter = new NewsletterRepository(salesDb)
  const payments = new PaymentRepository(salesDb)
  const inventory = new InventoryRepository(catalogDb)
  const promotions = new PromotionRepository(catalogDb)
  const catalogOptions = new CatalogOptionRepository(catalogDb)
  const storeBanners = new StoreBannerRepository(catalogDb)
  const storeSettings = new StoreSettingsRepository(identityDb)
  const notifications = new NotificationRepository(identityDb)
  const productionMaterialsRepo = new MaterialRepository(productionDb)
  const productionSuppliersRepo = new SupplierRepository(productionDb)
  const productionRecipesRepo = new RecipeRepository(productionDb)
  const productionConfigRepo = new ProductionConfigRepository(productionDb)
  const productionAuditRepo = new ProductionAuditRepository(productionDb)
  const productionUnitsRepo = new UnitRepository(productionDb)
  const authAudit = new AuthAuditRepository(identityDb)
  const twoFactorRepo = new TwoFactorRepository(identityDb)
  const roles = new RoleRepository(identityDb)
  const userRoles = new UserRoleRepository(identityDb)

  await Promise.all([
    users.ensureIndexes().catch((err) => logger.warn({ err }, 'users indexes skipped')),
    sessions.ensureIndexes().catch((err) => logger.warn({ err }, 'sessions indexes skipped')),
    authAudit.ensureIndexes().catch((err) => logger.warn({ err }, 'auth audit indexes skipped')),
    roles.ensureIndexes().catch((err) => logger.warn({ err }, 'roles indexes skipped')),
    userRoles.ensureIndexes().catch((err) => logger.warn({ err }, 'user_roles indexes skipped')),
    products.ensureIndexes().catch((err) => logger.warn({ err }, 'products indexes skipped')),
    categories.ensureIndexes().catch((err) => logger.warn({ err }, 'categories indexes skipped')),
    orders.ensureIndexes().catch((err) => logger.warn({ err }, 'orders indexes skipped')),
    carts.ensureIndexes().catch((err) => logger.warn({ err }, 'carts indexes skipped')),
    favorites.ensureIndexes().catch((err) => logger.warn({ err }, 'favorites indexes skipped')),
    reviews.ensureIndexes().catch((err) => logger.warn({ err }, 'reviews indexes skipped')),
    newsletter.ensureIndexes().catch((err) => logger.warn({ err }, 'newsletter indexes skipped')),
    payments.ensureIndexes().catch((err) => logger.warn({ err }, 'payments indexes skipped')),
    promotions.ensureIndexes().catch((err) => logger.warn({ err }, 'promotions indexes skipped')),
    catalogOptions.ensureIndexes().catch((err) => logger.warn({ err }, 'catalog options indexes skipped')),
    storeBanners.ensureIndexes().catch((err) => logger.warn({ err }, 'store banners indexes skipped')),
    notifications.ensureIndexes().catch((err) => logger.warn({ err }, 'notifications indexes skipped')),
    productionMaterialsRepo.ensureIndexes().catch((err) => logger.warn({ err }, 'production materials indexes skipped')),
    productionSuppliersRepo.ensureIndexes().catch((err) => logger.warn({ err }, 'production suppliers indexes skipped')),
    productionRecipesRepo.ensureIndexes().catch((err) => logger.warn({ err }, 'production recipes indexes skipped')),
    productionConfigRepo.ensureIndexes().catch((err) => logger.warn({ err }, 'production config indexes skipped')),
    productionAuditRepo.ensureIndexes().catch((err) => logger.warn({ err }, 'production audit indexes skipped')),
    productionUnitsRepo.ensureIndexes().catch((err) => logger.warn({ err }, 'production units indexes skipped')),
  ])

  const jwt = new JwtTokenService()
  const authorization = new AuthorizationService(roles, userRoles)
  let auth: AuthService
  const twoFactor = new TwoFactorService(users, twoFactorRepo, authAudit, () => auth)
  auth = new AuthService(users, sessions, jwt, authAudit, twoFactor, authorization)
  const manualPayments = new ManualPaymentService(payments, orders, carts)
  const store = new StoreService(storeSettings, storeBanners)
  const adminDashboard = new DashboardService(users, sessions, products, orders, promotions, favorites)
  const adminProducts = new AdminProductService(products, categories, catalogOptions)
  const adminOrders = new AdminOrderService(orders, users)
  const adminCategories = new AdminCategoryService(categories)
  const adminStore = new AdminStoreService(storeSettings)
  const adminPromotions = new AdminPromotionService(promotions)
  const adminBanners = new AdminBannerService(storeBanners)
  const adminInventory = new AdminInventoryService(inventory)
  const adminStaff = new AdminStaffService(users)
  const registry = new RegistryRepository(identityDb)
  const adminRegistry = new AdminRegistryService(registry)
  const adminSession = new AdminSessionService(sessions)
  const adminAnalytics = new AdminAnalyticsService(orders, users, products)
  const feedbackReports = new FeedbackReportRepository(salesDb)
  const adminFeedback = new AdminFeedbackService(reviews, feedbackReports)

  const productionUnitConversion = new UnitConversionService(productionUnitsRepo)
  const productionCosting = new CostingService(
    productionRecipesRepo,
    productionMaterialsRepo,
    productionConfigRepo,
    productionAuditRepo,
    productionUnitConversion,
  )
  const productionMaterials = new MaterialService(productionMaterialsRepo, productionRecipesRepo, productionAuditRepo)
  const productionSuppliers = new SupplierService(productionSuppliersRepo)
  const productionRecipes = new RecipeService(
    productionRecipesRepo,
    productionMaterialsRepo,
    productionAuditRepo,
    productionCosting,
  )
  const productionUnits = new UnitService(productionUnitsRepo)
  const productionConfig = new ProductionConfigService(productionConfigRepo, productionAuditRepo)
  const productionDashboard = new ProductionDashboardService(
    productionDb,
    productionMaterialsRepo,
    productionSuppliersRepo,
    productionRecipesRepo,
  )
  const productionAudit = new ProductionAuditService(productionAuditRepo)
  const securityAdmin = new SecurityAdminService(roles, userRoles, users, registry, authorization)

  return {
    env,
    logger,
    mongo,
    redis: redisManager,
    cache,
    repos: {
      users,
      sessions,
      products,
      categories,
      orders,
      carts,
      favorites,
      reviews,
      newsletter,
      payments,
      inventory,
      promotions,
      storeBanners,
      storeSettings,
      notifications,
      authAudit,
      roles,
      userRoles,
      productionMaterials: productionMaterialsRepo,
      productionSuppliers: productionSuppliersRepo,
      productionRecipes: productionRecipesRepo,
      productionConfig: productionConfigRepo,
      productionAudit: productionAuditRepo,
      productionUnits: productionUnitsRepo,
    },
    services: {
      auth,
      authorization,
      twoFactor,
      securityAdmin,
      products: new ProductService(products, promotions),
      categories: new CategoryService(categories),
      orders: new OrderService(orders, carts, inventory, manualPayments),
      cart: new CartService(carts, products),
      favorites: new FavoritesService(favorites),
      feedback: new FeedbackService(reviews, products),
      newsletter: new NewsletterService(newsletter),
      googleOAuth: new GoogleOAuthService(users, auth, carts),
      manualPayments,
      store,
      notifications: new NotificationService(notifications),
      adminDashboard,
      adminProducts,
      adminOrders,
      adminCategories,
      adminStore,
      adminPromotions,
      adminBanners,
      adminInventory,
      adminStaff,
      adminRegistry,
      adminSession,
      adminAnalytics,
      adminFeedback,
      productionMaterials,
      productionSuppliers,
      productionRecipes,
      productionUnits,
      productionConfig,
      productionDashboard,
      productionAudit,
      productionCosting,
    },
    jwt,
  }
}

export async function shutdownAppContext(ctx: AppContext): Promise<void> {
  await ctx.redis.close()
  await ctx.mongo.closeAll()
}

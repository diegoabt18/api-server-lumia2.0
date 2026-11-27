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
import { SubcategoryRepository } from './modules/catalog/infrastructure/subcategory.repository.js'
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
import { MaterialSupplierRepository } from './modules/production/infrastructure/material-supplier.repository.js'
import { MaterialSupplierService } from './modules/production/services/material-supplier.service.js'
import { OrderStockService } from './modules/sales/services/order-stock.service.js'
import { OrderPaymentService } from './modules/sales/services/order-payment.service.js'
import { OrderFinancialEvents } from './modules/sales/services/order-financial-events.service.js'
import { OnlinePaymentService } from './modules/payments/services/online-payment.service.js'
import { createMercadoPagoClient } from './modules/payments/infrastructure/mercadopago.client.js'
import { isMercadoPagoEnabled } from './modules/payments/domain/mercadopago-gate.js'
import { PromotionRepository } from './modules/catalog/infrastructure/promotion.repository.js'
import { StoreBannerRepository } from './modules/catalog/infrastructure/store-banner.repository.js'
import { StoreSettingsRepository } from './modules/store/infrastructure/store-settings.repository.js'
import { StoreService } from './modules/store/services/store.service.js'
import { NotificationRepository } from './modules/notifications/infrastructure/notification.repository.js'
import { NotificationService } from './modules/notifications/services/notification.service.js'
import { MailService } from './modules/notifications/services/mail.service.js'
import { PushService } from './modules/notifications/services/push.service.js'
import { PushDeviceRepository } from './modules/notifications/infrastructure/push-device.repository.js'
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
import { AdminUsersService } from './modules/admin/services/admin-users.service.js'
import { AdminAuditService } from './modules/admin/services/admin-audit.service.js'
import { AdminMetaService } from './modules/admin/services/admin-meta.service.js'
import { AdminPricingService } from './modules/admin/services/admin-pricing.service.js'
import { AdminCostSummaryService } from './modules/admin/services/admin-cost-summary.service.js'
import { CatalogOptionRepository } from './modules/catalog/infrastructure/catalog-option.repository.js'
import { RegistryRepository } from './modules/admin/infrastructure/registry.repository.js'
import { QuestionRepository } from './modules/sales/infrastructure/question.repository.js'
import { FeedbackReportRepository } from './modules/sales/infrastructure/feedback-report.repository.js'
import { MaterialRepository } from './modules/production/infrastructure/material.repository.js'
import { SupplierRepository } from './modules/production/infrastructure/supplier.repository.js'
import { RecipeRepository } from './modules/production/infrastructure/recipe.repository.js'
import { ProductionConfigRepository } from './modules/production/infrastructure/production-config.repository.js'
import { ProductionAuditRepository } from './modules/production/infrastructure/production-audit.repository.js'
import { UnitRepository } from './modules/production/infrastructure/unit.repository.js'
import { UnitEquivalenceRepository } from './modules/production/infrastructure/unit-equivalence.repository.js'
import { IndirectCostRepository } from './modules/production/infrastructure/indirect-cost.repository.js'
import { PriceApprovalRepository } from './modules/production/infrastructure/price-approval.repository.js'
import { CostImpactRepository } from './modules/production/infrastructure/cost-impact.repository.js'
import { LaborCostRepository } from './modules/production/infrastructure/labor-cost.repository.js'
import { PackagingCostRepository } from './modules/production/infrastructure/packaging-cost.repository.js'
import { RecipeProductionCostRepository } from './modules/production/infrastructure/recipe-production-cost.repository.js'
import { ServiceCostRepository } from './modules/production/infrastructure/service-cost.repository.js'
import { RecipeVersionRepository } from './modules/production/infrastructure/recipe-version.repository.js'
import { CostSheetRepository } from './modules/production/infrastructure/cost-sheet.repository.js'
import { UnitConversionService } from './modules/production/services/unit-conversion.service.js'
import { EquivalenceService } from './modules/production/services/equivalence.service.js'
import { IndirectCostService } from './modules/production/services/indirect-cost.service.js'
import { PriceApprovalService } from './modules/production/services/price-approval.service.js'
import { CostImpactService } from './modules/production/services/cost-impact.service.js'
import { CostingService } from './modules/production/services/costing.service.js'
import { MaterialService } from './modules/production/services/material.service.js'
import { SupplierService } from './modules/production/services/supplier.service.js'
import { RecipeService } from './modules/production/services/recipe.service.js'
import { VariantPriceRepostService } from './modules/production/services/variant-price-repost.service.js'
import { UnitService } from './modules/production/services/unit.service.js'
import { ProductionConfigService } from './modules/production/services/production-config.service.js'
import { ProductionAuditService, ProductionDashboardService } from './modules/production/services/dashboard.service.js'
import { SecurityMaintenance } from './modules/security/services/security-maintenance.js'
import { ActivityAuditRepository } from './modules/admin-activity/infrastructure/activity-audit.repository.js'
import { activityAuditKey } from './modules/admin-activity/domain/signing-key.js'
import { AuthAuditRepository } from './modules/identity/infrastructure/auth-audit.repository.js'
import { TwoFactorRepository } from './modules/identity/infrastructure/two-factor.repository.js'
import { PosCustomerRepository } from './modules/identity/infrastructure/pos-customer.repository.js'
import { FinancialOutboxRepository } from './modules/sales/infrastructure/financial-outbox.repository.js'
import { TwoFactorService } from './modules/identity/services/two-factor.service.js'
import { AttemptLimiter } from './modules/identity/infrastructure/attempt-limiter.js'
import { RoleRepository } from './modules/security/infrastructure/role.repository.js'
import { UserRoleRepository } from './modules/security/infrastructure/user-role.repository.js'
import { TemporalPermissionRepository } from './modules/security/infrastructure/temporal-permission.repository.js'
import { UserPermissionOverrideRepository } from './modules/security/infrastructure/user-permission-override.repository.js'
import { RoleDelegationRepository } from './modules/security/infrastructure/role-delegation.repository.js'
import { PermissionTemplateRepository } from './modules/security/infrastructure/permission-template.repository.js'
import { ConditionalPermissionRepository } from './modules/security/infrastructure/conditional-permission.repository.js'
import { ApprovalRequestRepository } from './modules/security/infrastructure/approval-request.repository.js'
import { ScheduledChangeRepository } from './modules/security/infrastructure/scheduled-change.repository.js'
import { PermissionAuditRepository } from './modules/security/infrastructure/permission-audit.repository.js'
import { SecurityWebhookRepository } from './modules/security/infrastructure/security-webhook.repository.js'
import { AuthorizationService } from './modules/security/services/authorization.service.js'
import { SecurityAdminService } from './modules/security/services/security-admin.service.js'
import { SecurityEnterpriseService } from './modules/security/services/security-enterprise.service.js'
import { PermissionCacheService } from './modules/security/services/permission-cache.service.js'
import { PosSaleService } from './modules/pos/services/pos-sale.service.js'
import { LumiAutomationRepository } from './modules/lumi/automation/infrastructure/lumi-automation.repository.js'
import {
  LocalAutomationLock,
  RedisAutomationLock,
  RepositoryNotificationSink,
} from './modules/lumi/automation/infrastructure/automation-adapters.js'
import { AutomationWorker, DEFAULT_WORKER_OPTIONS } from './modules/lumi/automation/services/automation-worker.js'
import {
  AutomationScheduler,
  DEFAULT_SCHEDULER_OPTIONS,
} from './modules/lumi/automation/services/automation-scheduler.js'
import { LumiTaskManager } from './modules/lumi/automation/services/task-manager.service.js'
import { AutomationCommands } from './modules/lumi/automation/services/automation-commands.js'
import { NotificationStreamHub } from './modules/notifications/services/notification-stream.hub.js'
import { RedisNotificationBus } from './modules/notifications/infrastructure/redis-notification-bus.js'
import { createFollowUpHandler } from './modules/lumi/automation/services/reminder-handlers.js'
import { MongoPendingActions } from './modules/lumi/actions/pending-action.js'
import { type ActiveEntityStore, MongoActiveEntities } from './modules/lumi/selector/active-entity.js'
import { LumiInitiativeRepository } from './modules/lumi/initiatives/infrastructure/lumi-initiative.repository.js'
import { LumiCapabilityRepository } from './modules/lumi/capabilities/infrastructure/lumi-capability.repository.js'
import { LumiCapabilityService } from './modules/lumi/capabilities/services/capability.service.js'
import { LumiCapabilityTestRepository } from './modules/lumi/capabilities/infrastructure/lumi-capability-test.repository.js'
import { CapabilityTestService } from './modules/lumi/capabilities/services/capability-test.service.js'
import { SandboxTurnRunner } from './modules/lumi/capabilities/services/sandbox-runner.js'
import { LumiToolGate } from './modules/lumi/capabilities/services/tool-gate.js'
import { CapabilityActivationService } from './modules/lumi/capabilities/services/capability-activation.service.js'
import { LUMI_TOOLS } from './modules/lumi/tools/catalog.js'
import { LumiKnowledgeRepository } from './modules/lumi/learning/infrastructure/lumi-knowledge.repository.js'
import { LumiLearningService } from './modules/lumi/learning/services/learning.service.js'
import { MongoTurnMetrics, type TurnMetricsStore } from './modules/lumi/metrics/turn-metrics.js'
import { LumiAssistantClient } from './modules/lumi/infrastructure/lumi-assistant.client.js'
import {
  MongoConversationStore,
  type ConversationStore,
} from './modules/lumi/conversation/conversation.store.js'
import { createLumiToolDeps } from './modules/lumi/tools/tool-adapters.js'
import { DEFAULT_AUTOMATION_TIMEZONE } from './modules/lumi/automation/domain/schedule.js'
import { RepositoryInitiativeSources } from './modules/lumi/initiatives/infrastructure/initiative-sources.js'
import { InitiativeEngine } from './modules/lumi/initiatives/services/initiative-engine.js'
import { InitiativeScheduler, DEFAULT_INITIATIVE_SCHEDULER_OPTIONS } from './modules/lumi/initiatives/services/initiative-scheduler.js'
import { LumiInitiativeService } from './modules/lumi/initiatives/services/initiative.service.js'
import { createDesktopAgentServices, type DesktopAgentServices } from './modules/lumi/desktop-agent/index.js'

export interface AppContext {
  env: Env
  logger: AppLogger
  mongo: MongoConnectionManager
  redis: RedisManager
  cache: CacheService
  /** Scheduler único del motor de automatización de Lumi. Se arranca desde server.ts. */
  automation: AutomationScheduler
  initiatives: InitiativeScheduler
  /** Caducidad periódica de permisos temporales y delegaciones (fuera de la ruta de lectura). */
  securityMaintenance: SecurityMaintenance
  /** Registro de actividad administrativa (solo inserción, HMAC encadenado). */
  activityAudit: ActivityAuditRepository
  repos: {
    users: UserRepository
    sessions: SessionRepository
    products: ProductRepository
    categories: CategoryRepository
    subcategories: SubcategoryRepository
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
    pushDevices: PushDeviceRepository
    authAudit: AuthAuditRepository
    roles: RoleRepository
    userRoles: UserRoleRepository
    temporalPermissions: TemporalPermissionRepository
    userPermissionOverrides: UserPermissionOverrideRepository
    roleDelegations: RoleDelegationRepository
    permissionTemplates: PermissionTemplateRepository
    conditionalPermissions: ConditionalPermissionRepository
    approvalRequests: ApprovalRequestRepository
    scheduledChanges: ScheduledChangeRepository
    permissionAudit: PermissionAuditRepository
    securityWebhooks: SecurityWebhookRepository
    productionMaterials: MaterialRepository
    productionSuppliers: SupplierRepository
    productionRecipes: RecipeRepository
    productionConfig: ProductionConfigRepository
    productionAudit: ProductionAuditRepository
    productionUnits: UnitRepository
    productionEquivalences: UnitEquivalenceRepository
    productionIndirectCosts: IndirectCostRepository
    productionApprovals: PriceApprovalRepository
    productionImpacts: CostImpactRepository
    productionLaborCosts: LaborCostRepository
    productionPackagingCosts: PackagingCostRepository
    productionRecipeCosts: RecipeProductionCostRepository
    productionServiceCosts: ServiceCostRepository
    productionRecipeVersions: RecipeVersionRepository
    productionCostSheets: CostSheetRepository
  }
  services: {
    lumiTasks: LumiTaskManager
    lumiInitiatives: LumiInitiativeService
    lumiCommands: AutomationCommands
    /** Historial de conversaciones de Lumi (MongoDB, compartido entre clientes). */
    lumiConversations: ConversationStore
    /** Context Manager de Lumi: entidad activa por conversación (caduca sola). */
    lumiActiveEntities: ActiveEntityStore
    /** Capability Manager: peticiones que ninguna herramienta resuelve, agrupadas para el panel. */
    lumiCapabilities: LumiCapabilityService
    /** Entorno de pruebas de capacidades (fase D). */
    lumiCapabilityTests: CapabilityTestService
    /** Fase E: herramientas habilitadas para el chat y su activación. */
    lumiToolGate: LumiToolGate
    lumiCapabilityActivation: CapabilityActivationService
    /** Fase F: Learning Engine. */
    lumiLearning: LumiLearningService
    /** Fase G: métricas de turnos. */
    lumiTurnMetrics: TurnMetricsStore
    /** Lumia Desktop Agent (fase 1: registro y conexión). null si DESKTOP_AGENT_ENABLED=false. */
    desktopAgent: DesktopAgentServices | null
    notificationHub: NotificationStreamHub
    auth: AuthService
    authorization: AuthorizationService
    twoFactor: TwoFactorService
    securityAdmin: SecurityAdminService
    securityEnterprise: SecurityEnterpriseService
    permissionCache: PermissionCacheService
    products: ProductService
    categories: CategoryService
    orders: OrderService
    cart: CartService
    favorites: FavoritesService
    feedback: FeedbackService
    newsletter: NewsletterService
    googleOAuth: GoogleOAuthService
    manualPayments: ManualPaymentService
    onlinePayments: OnlinePaymentService
    store: StoreService
    notifications: NotificationService
    push: PushService
    adminDashboard: DashboardService
    adminProducts: AdminProductService
    adminOrders: AdminOrderService
    orderPayments: OrderPaymentService
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
    adminUsers: AdminUsersService
    adminAudit: AdminAuditService
    adminMeta: AdminMetaService
    adminPricing: AdminPricingService
    adminCostSummary: AdminCostSummaryService
    pos: PosSaleService
    productionMaterials: MaterialService
    productionMaterialSuppliers: MaterialSupplierService
    productionSuppliers: SupplierService
    productionRecipes: RecipeService
    productionUnits: UnitService
    productionConfig: ProductionConfigService
    productionDashboard: ProductionDashboardService
    productionAudit: ProductionAuditService
    productionCosting: CostingService
    productionUnitConversion: UnitConversionService
    productionEquivalences: EquivalenceService
    productionIndirectCosts: IndirectCostService
    productionApprovals: PriceApprovalService
    productionVariantRepost: VariantPriceRepostService
    productionImpact: CostImpactService
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
  const subcategories = new SubcategoryRepository(catalogDb)
  const orders = new OrderRepository(salesDb)
  const carts = new CartRepository(salesDb)
  const favorites = new FavoritesRepository(salesDb)
  const reviews = new ReviewRepository(salesDb)
  const questionRepo = new QuestionRepository(salesDb)
  const newsletter = new NewsletterRepository(salesDb)
  const payments = new PaymentRepository(salesDb)
  const inventory = new InventoryRepository(catalogDb)
  const promotions = new PromotionRepository(catalogDb)
  const catalogOptions = new CatalogOptionRepository(catalogDb)
  const storeBanners = new StoreBannerRepository(catalogDb)
  const storeSettings = new StoreSettingsRepository(identityDb)
  const notifications = new NotificationRepository(identityDb)
  const pushDevices = new PushDeviceRepository(identityDb)
  const productionMaterialsRepo = new MaterialRepository(productionDb)
  const productionSuppliersRepo = new SupplierRepository(productionDb)
  const productionRecipesRepo = new RecipeRepository(productionDb)
  const productionConfigRepo = new ProductionConfigRepository(productionDb)
  const productionAuditRepo = new ProductionAuditRepository(productionDb)
  const productionUnitsRepo = new UnitRepository(productionDb)
  const productionEquivalencesRepo = new UnitEquivalenceRepository(productionDb)
  const productionIndirectCostsRepo = new IndirectCostRepository(productionDb)
  const productionApprovalsRepo = new PriceApprovalRepository(productionDb)
  const productionImpactsRepo = new CostImpactRepository(productionDb)
  const productionLaborCostsRepo = new LaborCostRepository(productionDb)
  const productionPackagingCostsRepo = new PackagingCostRepository(productionDb)
  const productionRecipeCostsRepo = new RecipeProductionCostRepository(productionDb)
  const productionServiceCostsRepo = new ServiceCostRepository(productionDb)
  const productionRecipeVersionsRepo = new RecipeVersionRepository(productionDb)
  const productionCostSheetsRepo = new CostSheetRepository(productionDb)
  const authAudit = new AuthAuditRepository(identityDb)
  const activityAudit = new ActivityAuditRepository(identityDb, activityAuditKey(env))
  await activityAudit
    .ensureIndexes()
    .catch((err) => logger.warn({ err }, 'admin activity audit indexes skipped'))
  const twoFactorRepo = new TwoFactorRepository(identityDb)
  const posCustomers = new PosCustomerRepository(identityDb)
  const financialOutbox = new FinancialOutboxRepository(salesDb)
  const roles = new RoleRepository(identityDb)
  const userRoles = new UserRoleRepository(identityDb)
  const temporalPermissions = new TemporalPermissionRepository(identityDb)
  const userPermissionOverrides = new UserPermissionOverrideRepository(identityDb)
  const roleDelegations = new RoleDelegationRepository(identityDb)
  const permissionTemplates = new PermissionTemplateRepository(identityDb)
  const conditionalPermissions = new ConditionalPermissionRepository(identityDb)
  const approvalRequests = new ApprovalRequestRepository(identityDb)
  const scheduledChanges = new ScheduledChangeRepository(identityDb)
  const permissionAudit = new PermissionAuditRepository(identityDb)
  const securityWebhooks = new SecurityWebhookRepository(identityDb)

  await Promise.all([
    users.ensureIndexes().catch((err) => logger.warn({ err }, 'users indexes skipped')),
    sessions.ensureIndexes().catch((err) => logger.warn({ err }, 'sessions indexes skipped')),
    authAudit.ensureIndexes().catch((err) => logger.warn({ err }, 'auth audit indexes skipped')),
    roles.ensureIndexes().catch((err) => logger.warn({ err }, 'roles indexes skipped')),
    userRoles.ensureIndexes().catch((err) => logger.warn({ err }, 'user_roles indexes skipped')),
    temporalPermissions.ensureIndexes().catch((err) => logger.warn({ err }, 'temporal_permissions indexes skipped')),
    userPermissionOverrides.ensureIndexes().catch((err) => logger.warn({ err }, 'user_permission_overrides indexes skipped')),
    roleDelegations.ensureIndexes().catch((err) => logger.warn({ err }, 'role_delegations indexes skipped')),
    permissionTemplates.ensureIndexes().catch((err) => logger.warn({ err }, 'permission_templates indexes skipped')),
    conditionalPermissions.ensureIndexes().catch((err) => logger.warn({ err }, 'conditional_permissions indexes skipped')),
    approvalRequests.ensureIndexes().catch((err) => logger.warn({ err }, 'approval_requests indexes skipped')),
    scheduledChanges.ensureIndexes().catch((err) => logger.warn({ err }, 'scheduled_changes indexes skipped')),
    permissionAudit.ensureIndexes().catch((err) => logger.warn({ err }, 'permission_audit indexes skipped')),
    securityWebhooks.ensureIndexes().catch((err) => logger.warn({ err }, 'security_webhooks indexes skipped')),
    products.ensureIndexes().catch((err) => logger.warn({ err }, 'products indexes skipped')),
    inventory.ensureIndexes().catch((err) => logger.warn({ err }, 'inventory indexes skipped')),
    posCustomers.ensureIndexes().catch((err) => logger.warn({ err }, 'pos_customers indexes skipped')),
    financialOutbox.ensureIndexes().catch((err) => logger.warn({ err }, 'financial_outbox indexes skipped')),
    categories.ensureIndexes().catch((err) => logger.warn({ err }, 'categories indexes skipped')),
    subcategories.ensureIndexes().catch((err) => logger.warn({ err }, 'subcategories indexes skipped')),
    orders.ensureIndexes().catch((err) => logger.warn({ err }, 'orders indexes skipped')),
    carts.ensureIndexes().catch((err) => logger.warn({ err }, 'carts indexes skipped')),
    favorites.ensureIndexes().catch((err) => logger.warn({ err }, 'favorites indexes skipped')),
    reviews.ensureIndexes().catch((err) => logger.warn({ err }, 'reviews indexes skipped')),
    questionRepo.ensureIndexes().catch((err) => logger.warn({ err }, 'product questions indexes skipped')),
    newsletter.ensureIndexes().catch((err) => logger.warn({ err }, 'newsletter indexes skipped')),
    payments.ensureIndexes().catch((err) => logger.warn({ err }, 'payments indexes skipped')),
    promotions.ensureIndexes().catch((err) => logger.warn({ err }, 'promotions indexes skipped')),
    catalogOptions.ensureIndexes().catch((err) => logger.warn({ err }, 'catalog options indexes skipped')),
    storeBanners.ensureIndexes().catch((err) => logger.warn({ err }, 'store banners indexes skipped')),
    notifications.ensureIndexes().catch((err) => logger.warn({ err }, 'notifications indexes skipped')),
    pushDevices.ensureIndexes().catch((err) => logger.warn({ err }, 'push_devices indexes skipped')),
    productionMaterialsRepo.ensureIndexes().catch((err) => logger.warn({ err }, 'production materials indexes skipped')),
    productionSuppliersRepo.ensureIndexes().catch((err) => logger.warn({ err }, 'production suppliers indexes skipped')),
    productionRecipesRepo.ensureIndexes().catch((err) => logger.warn({ err }, 'production recipes indexes skipped')),
    productionConfigRepo.ensureIndexes().catch((err) => logger.warn({ err }, 'production config indexes skipped')),
    productionAuditRepo.ensureIndexes().catch((err) => logger.warn({ err }, 'production audit indexes skipped')),
    productionUnitsRepo.ensureIndexes().catch((err) => logger.warn({ err }, 'production units indexes skipped')),
    productionEquivalencesRepo.ensureIndexes().catch((err) => logger.warn({ err }, 'production equivalences indexes skipped')),
    productionIndirectCostsRepo.ensureIndexes().catch((err) => logger.warn({ err }, 'production indirect costs indexes skipped')),
    productionApprovalsRepo.ensureIndexes().catch((err) => logger.warn({ err }, 'production approvals indexes skipped')),
    productionImpactsRepo.ensureIndexes().catch((err) => logger.warn({ err }, 'production impacts indexes skipped')),
    productionLaborCostsRepo.ensureIndexes().catch((err) => logger.warn({ err }, 'production labor costs indexes skipped')),
    productionPackagingCostsRepo.ensureIndexes().catch((err) => logger.warn({ err }, 'production packaging costs indexes skipped')),
    productionRecipeCostsRepo.ensureIndexes().catch((err) => logger.warn({ err }, 'production recipe costs indexes skipped')),
    productionServiceCostsRepo.ensureIndexes().catch((err) => logger.warn({ err }, 'production service costs indexes skipped')),
    productionRecipeVersionsRepo.ensureIndexes().catch((err) => logger.warn({ err }, 'production recipe versions indexes skipped')),
    productionCostSheetsRepo.ensureIndexes().catch((err) => logger.warn({ err }, 'production cost sheets indexes skipped')),
  ])

  const jwt = new JwtTokenService()
  const permissionCache = new PermissionCacheService(cache)
  const authorization = new AuthorizationService(
    roles,
    userRoles,
    temporalPermissions,
    userPermissionOverrides,
    roleDelegations,
    conditionalPermissions,
    permissionCache,
  )
  let auth: AuthService
  const lockWindow = env.LOGIN_LOCK_WINDOW_SECONDS
  const twoFactor = new TwoFactorService(
    users,
    twoFactorRepo,
    authAudit,
    () => auth,
    new AttemptLimiter(redisClient, {
      prefix: 'auth:2fa-fail:',
      maxFailures: env.TWO_FACTOR_MAX_FAILURES,
      windowSeconds: lockWindow,
    }),
  )
  auth = new AuthService(
    users,
    sessions,
    jwt,
    authAudit,
    twoFactor,
    authorization,
    new AttemptLimiter(redisClient, {
      prefix: 'auth:login-fail:',
      maxFailures: env.LOGIN_MAX_FAILURES,
      windowSeconds: lockWindow,
    }),
  )
  const manualPayments = new ManualPaymentService(payments, orders, carts)
  const mercadoPagoClient = isMercadoPagoEnabled(env)
    ? createMercadoPagoClient({ accessToken: env.MP_ACCESS_TOKEN as string })
    : null
  const onlinePayments = new OnlinePaymentService(
    payments,
    orders,
    carts,
    inventory,
    manualPayments,
    mercadoPagoClient,
    {
      frontendUrl: env.FRONTEND_URL.replace(/\/$/, ''),
      notificationUrl: `${env.APP_URL.replace(/\/$/, '')}/api/mercadopago/webhook`,
    },
  )
  const mail = new MailService(
    {
      enabled: env.EMAIL_ENABLED,
      smtpHost: env.SMTP_HOST,
      smtpPort: env.SMTP_PORT,
      smtpSecure: env.SMTP_SECURE,
      smtpUser: env.SMTP_USER,
      smtpPass: env.SMTP_PASS,
      mailFrom: env.MAIL_FROM,
      salesNotifyEmail: env.SALES_NOTIFY_EMAIL,
    },
    logger,
  )
  mail.logStartupStatus()
  void mail.verifySmtpConnection()
  const push = new PushService(
    {
      enabled: env.FCM_ENABLED,
      projectId: env.FCM_PROJECT_ID,
      clientEmail: env.FCM_CLIENT_EMAIL,
      privateKey: env.FCM_PRIVATE_KEY,
    },
    pushDevices,
    logger,
  )
  const store = new StoreService(storeSettings, storeBanners)
  const adminDashboard = new DashboardService(users, sessions, products, orders, promotions, favorites)
  const adminProducts = new AdminProductService(products, categories, catalogOptions, subcategories)
  const orderStock = new OrderStockService(inventory, orders)
  const orderFinancialEvents = new OrderFinancialEvents(financialOutbox)
  const orderPayments = new OrderPaymentService(orders, payments, orderStock)
  const adminOrders = new AdminOrderService(orders, users, orderStock, orderFinancialEvents)
  const adminCategories = new AdminCategoryService(categories, subcategories)
  const adminStore = new AdminStoreService(storeSettings)
  const adminPromotions = new AdminPromotionService(promotions)
  const adminBanners = new AdminBannerService(storeBanners)
  const adminInventory = new AdminInventoryService(inventory, productionAuditRepo)
  const adminStaff = new AdminStaffService(users, authorization, roles, userRoles)
  const registry = new RegistryRepository(identityDb)
  const adminRegistry = new AdminRegistryService(registry)
  // Crea en `permissions` los permisos del código que falten. No toca roles ni permisos existentes.
  adminRegistry
    .seedMissingPermissions()
    .catch((err) => logger.warn({ err }, 'permission seed skipped'))
  const adminSession = new AdminSessionService(sessions)
  const adminAnalytics = new AdminAnalyticsService(orders, users, products)
  const feedbackReports = new FeedbackReportRepository(salesDb)
  const feedbackService = new FeedbackService(reviews, questionRepo, feedbackReports, products)
  const adminFeedback = new AdminFeedbackService(reviews, feedbackReports, feedbackService)
  const adminUsers = new AdminUsersService(users, orders, roles, userRoles, authorization)
  const adminAudit = new AdminAuditService(authAudit)
  const adminMeta = new AdminMetaService(env)
  const adminPricing = new AdminPricingService(productionConfigRepo)
  const pos = new PosSaleService(orders, products, inventory, promotions, users, payments, storeSettings, posCustomers, financialOutbox, orderPayments)

  const productionUnitConversion = new UnitConversionService(productionUnitsRepo, productionEquivalencesRepo)
  const productionCosting = new CostingService(
    productionRecipesRepo,
    productionMaterialsRepo,
    productionConfigRepo,
    productionAuditRepo,
  )
  const adminCostSummary = new AdminCostSummaryService(products, productionRecipesRepo, productionConfigRepo, productionCosting)

  const productionMaterials = new MaterialService(productionMaterialsRepo, productionRecipesRepo, productionAuditRepo)
  const productionMaterialSuppliers = new MaterialSupplierService(
    productionMaterialsRepo,
    productionSuppliersRepo,
    new MaterialSupplierRepository(productionDb),
  )
  const productionSuppliers = new SupplierService(productionSuppliersRepo)
  const productionRecipes = new RecipeService(
    productionRecipesRepo,
    productionMaterialsRepo,
    productionAuditRepo,
    productionCosting,
    products,
    productionRecipeVersionsRepo,
    productionCostSheetsRepo,
    productionLaborCostsRepo,
    productionPackagingCostsRepo,
    productionRecipeCostsRepo,
    productionServiceCostsRepo,
    productionApprovalsRepo,
  )
  const productionUnits = new UnitService(productionUnitsRepo)
  const productionEquivalences = new EquivalenceService(
    productionEquivalencesRepo,
    productionUnitsRepo,
    productionUnitConversion,
  )
  const productionIndirectCosts = new IndirectCostService(productionIndirectCostsRepo)
  const productionApprovals = new PriceApprovalService(productionApprovalsRepo, productionAuditRepo, products)
  const productionVariantRepost = new VariantPriceRepostService(
    products,
    productionRecipesRepo,
    productionCosting,
    productionCostSheetsRepo,
    productionApprovalsRepo,
    productionAuditRepo,
  )
  const productionImpact = new CostImpactService(productionImpactsRepo, productionAuditRepo)
  const productionConfig = new ProductionConfigService(productionConfigRepo, productionAuditRepo)
  const productionDashboard = new ProductionDashboardService(
    productionDb,
    productionMaterialsRepo,
    productionSuppliersRepo,
    productionRecipesRepo,
  )
  const productionAudit = new ProductionAuditService(productionAuditRepo)
  const securityAdmin = new SecurityAdminService(roles, userRoles, users, registry, authorization)
  const securityEnterprise = new SecurityEnterpriseService(
    roles,
    userRoles,
    users,
    registry,
    authorization,
    temporalPermissions,
    userPermissionOverrides,
    roleDelegations,
    permissionTemplates,
    conditionalPermissions,
    approvalRequests,
    scheduledChanges,
    permissionAudit,
    securityWebhooks,
    authAudit,
    sessions,
    permissionCache,
  )

  // Motor de automatización de Lumi (Fase 1): tareas, scheduler y worker. Sin Qwen.
  const lumiAutomationRepo = new LumiAutomationRepository(identityDb)
  await lumiAutomationRepo
    .ensureIndexes()
    .catch((err) => logger.warn({ err }, 'lumi automation indexes skipped'))
  const lumiTasks = new LumiTaskManager(lumiAutomationRepo)
  // Con Redis (obligatorio en producción) las notificaciones en tiempo real llegan a todas las
  // instancias; sin Redis, solo a las conexiones de este proceso.
  const notificationHub = new NotificationStreamHub(
    redisClient ? await RedisNotificationBus.create(redisClient, logger) : undefined,
    (err) => logger.warn({ err }, 'notification stream bus publish failed'),
  )
  const automationSink = new RepositoryNotificationSink(notifications, notificationHub)
  const automationWorker = new AutomationWorker(
    lumiAutomationRepo,
    automationSink,
    { ...DEFAULT_WORKER_OPTIONS, now: () => new Date() },
    { follow_up: createFollowUpHandler(lumiAutomationRepo, automationSink) },
  )
  // Acciones de Lumi que esperan confirmación (p. ej. borrar una rutina). Caducan con un índice TTL.
  const lumiPendingActions = new MongoPendingActions(identityDb)
  await lumiPendingActions
    .ensureIndexes()
    .catch((err) => logger.warn({ err }, 'lumi pending action indexes skipped'))
  // Entidad de la que se habla en cada conversación de Lumi ("¿y sus pagos?"). Índice TTL.
  const lumiActiveEntities = new MongoActiveEntities(identityDb)
  await lumiActiveEntities
    .ensureIndexes()
    .catch((err) => logger.warn({ err }, 'lumi context indexes skipped'))
  const lumiCapabilityRepo = new LumiCapabilityRepository(identityDb)
  await lumiCapabilityRepo
    .ensureIndexes()
    .catch((err) => logger.warn({ err }, 'lumi capability indexes skipped'))
  const lumiCapabilityTestRepo = new LumiCapabilityTestRepository(identityDb)
  await lumiCapabilityTestRepo
    .ensureIndexes()
    .catch((err) => logger.warn({ err }, 'lumi capability test indexes skipped'))
  const lumiCapabilities = new LumiCapabilityService(lumiCapabilityRepo, undefined, undefined, lumiCapabilityTestRepo)
  // Fase E: qué herramientas usa el chat lo decide lumi_capabilities (caché de 60 s).
  const lumiToolGate = new LumiToolGate(
    () => lumiCapabilityRepo.enabledToolNames(),
    LUMI_TOOLS.filter((t) => t.enabledByDefault).map((t) => t.name),
    (err) => logger.warn({ err }, 'lumi tool gate: using last known enabled tools'),
  )
  const lumiCapabilityActivation = new CapabilityActivationService(lumiCapabilityRepo, LUMI_TOOLS, lumiToolGate)
  // Fase F: Learning Engine (interpretaciones aprendidas, por usuario o globales aprobadas).
  const lumiKnowledgeRepo = new LumiKnowledgeRepository(identityDb)
  await lumiKnowledgeRepo
    .ensureIndexes()
    .catch((err) => logger.warn({ err }, 'lumi knowledge indexes skipped'))
  // Fase G: métricas diarias de turnos (sin texto ni usuario).
  const lumiTurnMetrics = new MongoTurnMetrics(identityDb)
  await lumiTurnMetrics
    .ensureIndexes()
    .catch((err) => logger.warn({ err }, 'lumi turn metrics indexes skipped'))
  // Lumia Desktop Agent: registro de equipos y pasarela WebSocket (solo con DESKTOP_AGENT_ENABLED).
  const desktopAgent = env.DESKTOP_AGENT_ENABLED ? await createDesktopAgentServices(identityDb, logger, {
        grantSigningKey: env.DESKTOP_GRANT_SIGNING_KEY,
        nodeEnv: env.NODE_ENV,
        pending: lumiPendingActions,
      }) : null
  const lumiLearning = new LumiLearningService(lumiKnowledgeRepo, {
    tools: LUMI_TOOLS,
    enabledTools: () => lumiToolGate.enabledTools(),
    recordMissing: (input) => lumiCapabilities.recordMissing(input),
    timezone: DEFAULT_AUTOMATION_TIMEZONE,
  })
  // Cada herramienta del registro tiene su capacidad. Las existentes nacen habilitadas; las nuevas no.
  await lumiCapabilityActivation
    .syncRegistry()
    .then((sync) => {
      const changed = sync.filter((s) => s.result !== 'unchanged')
      if (changed.length) logger.info({ lumiToolSync: changed }, 'lumi tool registry synced')
    })
    .catch((err) => logger.warn({ err }, 'lumi tool registry sync skipped'))
  // Conversaciones de Lumi en el Server (Lumi 2.0, Fase 1): la IA Assistant ya no guarda historial.
  const lumiConversations = new MongoConversationStore(identityDb)
  await lumiConversations
    .ensureIndexes()
    .catch((err) => logger.warn({ err }, 'lumi conversation indexes skipped'))
  const lumiCommands = new AutomationCommands(
    lumiTasks,
    lumiAutomationRepo,
    () => new Date(),
    undefined,
    lumiPendingActions,
  )

  // Iniciativas de Lumi (Fase 4): reglas sobre stock, pedidos y rutinas. Sin Qwen. Scheduler propio con lock.
  const initiativeRepo = new LumiInitiativeRepository(identityDb)
  await initiativeRepo
    .ensureIndexes()
    .catch((err) => logger.warn({ err }, 'lumi initiative indexes skipped'))
  const initiativeEngine = new InitiativeEngine(
    initiativeRepo,
    new RepositoryInitiativeSources(products, orders, lumiAutomationRepo),
    automationSink,
    () => new Date(),
    (err, userId) => logger.error({ err, userId }, 'Lumi initiative run failed for user'),
    // Cada usuario solo recibe iniciativas de los datos que puede ver (permisos efectivos, con caché).
    (userId) => authorization.resolveEffectivePermissions(userId),
  )
  const initiatives = new InitiativeScheduler(
    initiativeEngine,
    redisClient ? new RedisAutomationLock(redisClient) : new LocalAutomationLock(),
    DEFAULT_INITIATIVE_SCHEDULER_OPTIONS,
    (err) => logger.error({ err }, 'Lumi initiative scheduler tick failed'),
  )
  const lumiInitiatives = new LumiInitiativeService(initiativeRepo)

  // «Probar capacidad» (fase D): mismo plan de turno que el chat, solo lecturas, sin efectos.
  const lumiAssistantForTests =
    env.LUMI_ASSISTANT_URL && env.LUMI_ASSISTANT_API_KEY
      ? new LumiAssistantClient({
          baseUrl: env.LUMI_ASSISTANT_URL.replace(/\/+$/, ''),
          apiKey: env.LUMI_ASSISTANT_API_KEY,
          timeoutMs: env.LUMI_ASSISTANT_TIMEOUT_MS,
        })
      : null
  const lumiCapabilityTests = new CapabilityTestService(
    lumiCapabilityRepo,
    lumiCapabilityTestRepo,
    new SandboxTurnRunner({
      select: lumiAssistantForTests
        ? (userId, payload) => lumiAssistantForTests.select(userId, payload, env.LUMI_SELECTOR_TIMEOUT_MS)
        : null,
      selectorEnabled: env.LUMI_SELECTOR_ENABLED,
      enabledTools: () => lumiToolGate.enabledTools(),
      // Las pruebas aplican lo aprendido por quien prueba y lo global, igual que su chat.
      learned: (userId, message, enabled) => lumiLearning.learnedTool(userId, message, enabled, false),
      examples: (userId, message, enabled) => lumiLearning.examples(userId, message, enabled),
      toolDeps: createLumiToolDeps({
        orders,
        products,
        categories,
        notifications,
        initiatives: lumiInitiatives,
      }),
      timezone: DEFAULT_AUTOMATION_TIMEZONE,
    }),
  )
  const automation = new AutomationScheduler(
    lumiAutomationRepo,
    redisClient ? new RedisAutomationLock(redisClient) : new LocalAutomationLock(),
    automationWorker,
    { ...DEFAULT_SCHEDULER_OPTIONS, tickMs: env.LUMI_AUTOMATION_TICK_MS },
    () => new Date(),
    (err) => logger.error({ err }, 'Lumi automation tick failed'),
  )

  return {
    env,
    logger,
    mongo,
    redis: redisManager,
    cache,
    automation,
    initiatives,
    activityAudit,
    securityMaintenance: new SecurityMaintenance(
      () => authorization.expireOverdueGrants(),
      10 * 60_000,
      (err) => logger.error({ err }, 'security maintenance failed'),
    ),
    repos: {
      users,
      sessions,
      products,
      categories,
      subcategories,
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
      pushDevices,
      authAudit,
      roles,
      userRoles,
      temporalPermissions,
      userPermissionOverrides,
      roleDelegations,
      permissionTemplates,
      conditionalPermissions,
      approvalRequests,
      scheduledChanges,
      permissionAudit,
      securityWebhooks,
      productionMaterials: productionMaterialsRepo,
      productionSuppliers: productionSuppliersRepo,
      productionRecipes: productionRecipesRepo,
      productionConfig: productionConfigRepo,
      productionAudit: productionAuditRepo,
      productionUnits: productionUnitsRepo,
      productionEquivalences: productionEquivalencesRepo,
      productionIndirectCosts: productionIndirectCostsRepo,
      productionApprovals: productionApprovalsRepo,
      productionImpacts: productionImpactsRepo,
      productionLaborCosts: productionLaborCostsRepo,
      productionPackagingCosts: productionPackagingCostsRepo,
      productionRecipeCosts: productionRecipeCostsRepo,
      productionServiceCosts: productionServiceCostsRepo,
      productionRecipeVersions: productionRecipeVersionsRepo,
      productionCostSheets: productionCostSheetsRepo,
    },
    services: {
      lumiTasks,
      lumiInitiatives,
      lumiCommands,
      lumiConversations,
      lumiActiveEntities,
      lumiCapabilities,
      lumiCapabilityTests,
      lumiToolGate,
      lumiCapabilityActivation,
      lumiLearning,
      lumiTurnMetrics,
      desktopAgent,
      notificationHub,
      auth,
      authorization,
      twoFactor,
      securityAdmin,
      securityEnterprise,
      permissionCache,
      products: new ProductService(products, promotions, categories, subcategories),
      categories: new CategoryService(categories, subcategories),
      orders: new OrderService(orders, carts, inventory, manualPayments, mail, push, products, productionCostSheetsRepo, logger),
      orderPayments,
      cart: new CartService(carts, products),
      favorites: new FavoritesService(favorites),
      feedback: feedbackService,
      newsletter: new NewsletterService(newsletter),
      googleOAuth: new GoogleOAuthService(users, auth, carts),
      manualPayments,
      onlinePayments,
      store,
      notifications: new NotificationService(notifications),
      push,
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
      adminUsers,
      adminAudit,
      adminMeta,
      adminPricing,
      adminCostSummary,
      pos,
      productionMaterials,
      productionMaterialSuppliers,
      productionSuppliers,
      productionRecipes,
      productionUnits,
      productionConfig,
      productionDashboard,
      productionAudit,
      productionCosting,
      productionUnitConversion,
      productionEquivalences,
      productionIndirectCosts,
      productionApprovals,
      productionVariantRepost,
      productionImpact,
    },
    jwt,
  }
}

export async function shutdownAppContext(ctx: AppContext): Promise<void> {
  ctx.automation.stop()
  ctx.initiatives.stop()
  ctx.securityMaintenance.stop()
  ctx.services.desktopAgent?.shutdown()
  await ctx.services.notificationHub.close()
  await ctx.redis.close()
  await ctx.mongo.closeAll()
}

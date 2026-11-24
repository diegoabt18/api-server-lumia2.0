/**
 * Registro centralizado de permisos — compatible con lumia/shared/permission-registry.ts
 */
export const PERMISSION_REGISTRY = {
  ACCOUNT_READ: 'account.read',
  PAGE_CART: 'page.cart',
  CART_READ: 'cart.read',
  CART_WRITE: 'cart.write',
  ORDERS_READ: 'orders.read',
  ORDERS_CREATE: 'orders.create',
  ORDERS_UPDATE: 'orders.update',
  ORDERS_DELETE: 'orders.delete',
  PAYMENTS_CREATE: 'payments.create',
  PAYMENTS_REFUND: 'payments.refund',
  PRODUCTS_READ: 'products.read',
  PRODUCTS_CREATE: 'products.create',
  PRODUCTS_UPDATE: 'products.update',
  PRODUCTS_DELETE: 'products.delete',
  CATEGORIES_READ: 'categories.read',
  CATEGORIES_CREATE: 'categories.create',
  CATEGORIES_UPDATE: 'categories.update',
  CATEGORIES_DELETE: 'categories.delete',
  ADMIN_ACCESS: 'admin.access',
  ADMIN_SECURITY: 'admin.security',
  ADMIN_SECURITY_VIEW: 'admin.security.view',
  ADMIN_SECURITY_MANAGE: 'admin.security.manage',
  ADMIN_ROLES_READ: 'admin.roles.read',
  ADMIN_ROLES_MANAGE: 'admin.roles.manage',
  ADMIN_USERS_READ: 'admin.users.read',
  ADMIN_USERS_MANAGE: 'admin.users.manage',
  ADMIN_AUDIT_READ: 'admin.audit.read',
  ADMIN_SESSIONS_READ: 'admin.sessions.read',
  ADMIN_SESSIONS_REVOKE: 'admin.sessions.revoke',
  ADMIN_PERMISSIONS_READ: 'admin.permissions.read',
  ADMIN_PERMISSIONS_MANAGE: 'admin.permissions.manage',
  ANALYTICS_READ: 'analytics.read',
  MATERIALS_READ: 'materials.read',
  MATERIALS_CREATE: 'materials.create',
  MATERIALS_UPDATE: 'materials.update',
  MATERIALS_DELETE: 'materials.delete',
  SUPPLIERS_READ: 'suppliers.read',
  SUPPLIERS_CREATE: 'suppliers.create',
  SUPPLIERS_UPDATE: 'suppliers.update',
  SUPPLIERS_DELETE: 'suppliers.delete',
  RECIPES_READ: 'recipes.read',
  RECIPES_CREATE: 'recipes.create',
  RECIPES_UPDATE: 'recipes.update',
  RECIPES_DELETE: 'recipes.delete',
  COSTING_READ: 'costing.read',
  COSTING_MANAGE: 'costing.manage',
  PRODUCTION_CONFIG_READ: 'production.config.read',
  PRODUCTION_CONFIG_MANAGE: 'production.config.manage',
  UNITS_READ: 'units.read',
  UNITS_CREATE: 'units.create',
  UNITS_UPDATE: 'units.update',
  UNITS_DELETE: 'units.delete',
  EQUIVALENCES_READ: 'equivalences.read',
  EQUIVALENCES_CREATE: 'equivalences.create',
  EQUIVALENCES_UPDATE: 'equivalences.update',
  EQUIVALENCES_DELETE: 'equivalences.delete',
  /** Usar el asistente Lumi (ia-asistente) desde el panel administrativo. */
  LUMI_USE: 'lumi.use',
  /** Lumi con búsqueda web. Solo la pregunta sale a internet, nunca datos de la API ni contexto. */
  LUMI_WEB: 'lumi.web',
  /** Ver las capacidades que le faltan a Lumi (peticiones registradas desde el chat). */
  LUMI_CAPABILITIES_READ: 'lumi.capabilities.read',
  /** Gestionar esas capacidades: especificación, prioridad, estado y fusión. No las habilita. */
  LUMI_CAPABILITIES_MANAGE: 'lumi.capabilities.manage',
  /**
   * Probar capacidades con frases (fase D). Lee datos reales con los permisos de quien prueba;
   * nunca ejecuta escrituras.
   */
  LUMI_CAPABILITIES_TEST: 'lumi.capabilities.test',
  /** Habilitar o deshabilitar capacidades en el chat (fase E). Solo con la batería aprobada. */
  LUMI_CAPABILITIES_ENABLE: 'lumi.capabilities.enable',
  /** Ver lo que Lumi ha aprendido (interpretaciones de usuarios y globales). Fase F. */
  LUMI_LEARNING_READ: 'lumi.learning.read',
  /** Aprobar, retirar, hacer global o borrar interpretaciones aprendidas. Fase F. */
  LUMI_LEARNING_MANAGE: 'lumi.learning.manage',
  /**
   * Módulo de música de Lumi (suena en el servidor del asistente). Lectura: qué suena, buscar
   * canciones y por dónde suena. No cambia nada.
   */
  MUSIC_READ: 'music.read',
  /** Controlar la música: reproducir, pausar, reanudar, saltar y cambiar la salida (aux/Bluetooth). */
  MUSIC_CONTROL: 'music.control',
  /**
   * Permisos por módulo (2026-11). Antes estos módulos reutilizaban admin.access o products.*.
   * La migración scripts/migrate-module-permissions.ts los concede a quien ya tenía el acceso.
   */
  /** Ajustes de envío, moneda, atención al cliente y pagos: lectura. */
  STORE_SETTINGS_READ: 'store.settings.read',
  /** Ajustes de envío, moneda y atención al cliente: escritura. */
  STORE_SETTINGS_MANAGE: 'store.settings.manage',
  /** Ajustes de pagos (métodos y datos de cobro): escritura. Separado por ser sensible. */
  STORE_PAYMENTS_MANAGE: 'store.payments.manage',
  PROMOTIONS_READ: 'promotions.read',
  PROMOTIONS_CREATE: 'promotions.create',
  PROMOTIONS_UPDATE: 'promotions.update',
  PROMOTIONS_DELETE: 'promotions.delete',
  BANNERS_READ: 'banners.read',
  BANNERS_CREATE: 'banners.create',
  BANNERS_UPDATE: 'banners.update',
  BANNERS_DELETE: 'banners.delete',
  /** Reseñas, preguntas y reportes de la tienda: lectura. */
  FEEDBACK_READ: 'feedback.read',
  /** Moderar reseñas y preguntas (aprobar, ocultar, responder). */
  FEEDBACK_MODERATE: 'feedback.moderate',
  /** Existencias y política de anticipo por SKU: lectura. */
  INVENTORY_READ: 'inventory.read',
  /** Ajustar existencias y la política de anticipo por SKU. */
  INVENTORY_UPDATE: 'inventory.update',
  /** Lumia Desktop Agent: ver los equipos propios, su estado y sus capacidades. */
  DESKTOP_DEVICES_READ: 'desktop.devices.read',
  /** Inscribir equipos propios (código de un solo uso), renombrarlos y revocarlos. */
  DESKTOP_DEVICES_MANAGE: 'desktop.devices.manage',
  /**
   * Leer el navegador de un equipo propio: navegadores instalados, pestañas y snapshot de la página.
   * Un snapshot muestra contenido de la pantalla: no es un permiso inocuo.
   */
  DESKTOP_BROWSER_READ: 'desktop.browser.read',
  /** Controlar el navegador aislado de un equipo propio: navegar, pulsar, escribir, desplazar, cerrar. */
  DESKTOP_BROWSER_CONTROL: 'desktop.browser.control',
  /**
   * Leer aplicaciones de un equipo propio: aplicaciones y ventanas abiertas (con sus títulos),
   * árbol de accesibilidad y valores de campos. Muestra contenido privado de la pantalla.
   */
  DESKTOP_APPS_READ: 'desktop.apps.read',
  /** Actuar en aplicaciones de un equipo propio: pulsar, escribir en campos y teclas permitidas. */
  DESKTOP_APPS_CONTROL: 'desktop.apps.control',
  /** Ver las carpetas autorizadas de un equipo propio y descargar sus archivos (fase 6). */
  DESKTOP_FILES_READ: 'desktop.files.read',
  /** Enviar archivos a una carpeta autorizada de un equipo propio (nunca reemplaza ninguno). */
  DESKTOP_FILES_WRITE: 'desktop.files.write',
} as const

export type PermissionId = (typeof PERMISSION_REGISTRY)[keyof typeof PERMISSION_REGISTRY]
export const ALL_PERMISSION_IDS = Object.values(PERMISSION_REGISTRY) as PermissionId[]
export const PERMISSION_WILDCARD = '*' as const

export type UserRole = 'admin' | 'user' | 'moderator'

export function expandPermissions(keys: string[]): PermissionId[] {
  if (keys.includes(PERMISSION_WILDCARD)) return ALL_PERMISSION_IDS
  return keys.filter((k): k is PermissionId => ALL_PERMISSION_IDS.includes(k as PermissionId))
}

export function generatePermissionHash(keys: PermissionId[]): string {
  const sorted = [...new Set(keys)].sort()
  let hash = 0
  for (const key of sorted) {
    for (let i = 0; i < key.length; i++) {
      hash = (hash << 5) - hash + key.charCodeAt(i)
      hash |= 0
    }
  }
  return `ph_${Math.abs(hash).toString(36)}`
}

/** Snapshot de autorización a partir de los permisos efectivos (roles RBAC). Sin permisos = []. */
export function buildAuthzSnapshot(permissionKeys: PermissionId[] = []) {
  return {
    permissionKeys,
    permHash: generatePermissionHash(permissionKeys),
    permissionsVersion: 1,
    permissionUpdatedAt: new Date(),
  }
}

/** true si el valor es un identificador de permiso registrado. */
export function isPermissionId(value: unknown): value is PermissionId {
  return typeof value === 'string' && (ALL_PERMISSION_IDS as string[]).includes(value)
}

export function hasPermission(keys: PermissionId[], required: PermissionId): boolean {
  return keys.includes(required) || keys.includes(PERMISSION_WILDCARD as PermissionId)
}

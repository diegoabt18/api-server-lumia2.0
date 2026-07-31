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
} as const

export type PermissionId = (typeof PERMISSION_REGISTRY)[keyof typeof PERMISSION_REGISTRY]
export const ALL_PERMISSION_IDS = Object.values(PERMISSION_REGISTRY) as PermissionId[]
export const PERMISSION_WILDCARD = '*' as const

export type UserRole = 'admin' | 'user' | 'moderator'

/** Permisos por rol (simplificado; lumia también los tiene en MongoDB). */
export const ROLE_PERMISSIONS: Record<UserRole, PermissionId[]> = {
  admin: ALL_PERMISSION_IDS,
  moderator: [
    PERMISSION_REGISTRY.PRODUCTS_READ,
    PERMISSION_REGISTRY.PRODUCTS_UPDATE,
    PERMISSION_REGISTRY.CATEGORIES_READ,
    PERMISSION_REGISTRY.ORDERS_READ,
    PERMISSION_REGISTRY.ORDERS_UPDATE,
    PERMISSION_REGISTRY.ADMIN_ACCESS,
    PERMISSION_REGISTRY.ANALYTICS_READ,
  ],
  user: [
    PERMISSION_REGISTRY.ACCOUNT_READ,
    PERMISSION_REGISTRY.PAGE_CART,
    PERMISSION_REGISTRY.CART_READ,
    PERMISSION_REGISTRY.CART_WRITE,
    PERMISSION_REGISTRY.ORDERS_READ,
    PERMISSION_REGISTRY.ORDERS_CREATE,
    PERMISSION_REGISTRY.PRODUCTS_READ,
    PERMISSION_REGISTRY.CATEGORIES_READ,
    PERMISSION_REGISTRY.PAYMENTS_CREATE,
  ],
}

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

export function resolvePermissionsForRole(role: UserRole): PermissionId[] {
  return ROLE_PERMISSIONS[role] ?? ROLE_PERMISSIONS.user
}

export function buildAuthzSnapshot(role: UserRole) {
  const permissionKeys = resolvePermissionsForRole(role)
  return {
    permissionKeys,
    permHash: generatePermissionHash(permissionKeys),
    permissionsVersion: 1,
    permissionUpdatedAt: new Date(),
  }
}

export function hasPermission(keys: PermissionId[], required: PermissionId): boolean {
  return keys.includes(required) || keys.includes(PERMISSION_WILDCARD as PermissionId)
}

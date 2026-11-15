import { PERMISSION_REGISTRY as P, PERMISSION_WILDCARD } from '../../../common/permissions/registry.js'

/**
 * Migración aditiva a los permisos por módulo (2026-11).
 *
 * Antes, promociones, banners e inventario se autorizaban con products.*, y los ajustes de tienda
 * y la moderación con admin.access. Ahora cada módulo tiene sus permisos. Para que NADIE pierda el
 * acceso que tenía, a cada lista de permisos que contenga el permiso antiguo se le AÑADEN los nuevos.
 * Nunca se quita nada: los permisos antiguos siguen ahí y siguen sirviendo para su propio módulo.
 *
 * Las concesiones derivadas de admin.access se separan porque replican exactamente el agujero que
 * se quiere cerrar (cualquier administrador podía cambiar pagos y envíos). Aplicarlas o no es una
 * decisión del dueño: `preserve` mantiene el acceso actual; `skip` deja esos módulos solo a quien
 * tenga `*` o se le asignen después a mano.
 */

export type AdminAccessMode = 'preserve' | 'skip'

/** Permiso antiguo → permisos nuevos que daban el mismo acceso. */
export const PRODUCT_DERIVED_GRANTS: Readonly<Record<string, readonly string[]>> = {
  [P.PRODUCTS_READ]: [P.PROMOTIONS_READ, P.BANNERS_READ, P.INVENTORY_READ],
  [P.PRODUCTS_UPDATE]: [
    P.PROMOTIONS_CREATE,
    P.PROMOTIONS_UPDATE,
    P.PROMOTIONS_DELETE,
    P.BANNERS_CREATE,
    P.BANNERS_UPDATE,
    P.BANNERS_DELETE,
    P.INVENTORY_UPDATE,
  ],
}

export const ADMIN_ACCESS_DERIVED_GRANTS: Readonly<Record<string, readonly string[]>> = {
  [P.ADMIN_ACCESS]: [
    P.STORE_SETTINGS_READ,
    P.STORE_SETTINGS_MANAGE,
    P.STORE_PAYMENTS_MANAGE,
    P.FEEDBACK_READ,
    P.FEEDBACK_MODERATE,
  ],
}

/** Colecciones (identity_db) con listas `permissionKeys` que conceden o deniegan permisos. */
export const PERMISSION_LIST_COLLECTIONS = [
  'roles',
  'permission_templates',
  'temporal_permissions',
  'user_permission_overrides',
  'conditional_permissions',
] as const

/**
 * Permisos que hay que añadir a una lista. Devuelve [] si no hay nada que hacer: la migración es
 * idempotente. Las listas con `*` no se tocan (ya lo conceden todo). En las listas que DENIEGAN
 * (overrides de tipo deny) añadir los nuevos mantiene la misma semántica: lo que se denegaba sigue
 * denegado en su nuevo permiso.
 */
export function permissionsToAdd(keys: readonly string[], mode: AdminAccessMode): string[] {
  if (keys.includes(PERMISSION_WILDCARD)) return []
  const sources = mode === 'preserve' ? { ...PRODUCT_DERIVED_GRANTS, ...ADMIN_ACCESS_DERIVED_GRANTS } : PRODUCT_DERIVED_GRANTS
  const present = new Set(keys)
  const add = new Set<string>()
  for (const key of keys) {
    for (const derived of sources[key] ?? []) {
      if (!present.has(derived)) add.add(derived)
    }
  }
  return [...add].sort()
}

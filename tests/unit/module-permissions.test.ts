import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PERMISSION_REGISTRY as P, ALL_PERMISSION_IDS } from '../../src/common/permissions/registry.js'
import {
  ADMIN_ACCESS_DERIVED_GRANTS,
  PRODUCT_DERIVED_GRANTS,
  permissionsToAdd,
} from '../../src/modules/security/domain/module-permissions-migration.js'

/**
 * Regresión de autorización: lee admin.routes.ts y comprueba qué permiso protege cada ruta de los
 * módulos que antes reutilizaban admin.access o products.* (auditoría de viabilidad, sección C).
 */
const source = readFileSync(new URL('../../src/routes/admin.routes.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

function guardOf(method: string, route: string): string {
  const re = new RegExp(`api\\.${method}\\(\\s*'${route.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}'`)
  const found = re.exec(source)
  if (!found) throw new Error(`Ruta no encontrada: ${method.toUpperCase()} ${route}`)
  const rest = source.slice(found.index + found[0].length)
  const handler = rest.search(/async\s*\(/)
  const perm = /PERMISSION_REGISTRY\.(\w+)/.exec(rest.slice(0, handler))
  if (!perm) throw new Error(`Sin permiso explícito: ${method.toUpperCase()} ${route}`)
  return P[perm[1] as keyof typeof P]
}

describe('permisos por módulo en las rutas del Server', () => {
  it.each([
    ['get', '/admin/store-shipping-settings', P.STORE_SETTINGS_READ],
    ['put', '/admin/store-shipping-settings', P.STORE_SETTINGS_MANAGE],
    ['post', '/admin/store-shipping-settings/reset', P.STORE_SETTINGS_MANAGE],
    ['get', '/admin/store-currency-settings', P.STORE_SETTINGS_READ],
    ['patch', '/admin/store-currency-settings', P.STORE_SETTINGS_MANAGE],
    ['get', '/admin/store-customer-settings', P.STORE_SETTINGS_READ],
    ['patch', '/admin/store-customer-settings', P.STORE_SETTINGS_MANAGE],
    ['get', '/admin/store-payment-settings', P.STORE_SETTINGS_READ],
    ['patch', '/admin/store-payment-settings', P.STORE_PAYMENTS_MANAGE],
    ['get', '/admin/promotions', P.PROMOTIONS_READ],
    ['get', '/admin/promotions/products', P.PROMOTIONS_READ],
    ['get', '/admin/promotions/:id', P.PROMOTIONS_READ],
    ['post', '/admin/promotions', P.PROMOTIONS_CREATE],
    ['patch', '/admin/promotions/:id', P.PROMOTIONS_UPDATE],
    ['patch', '/admin/promotions/:id/active', P.PROMOTIONS_UPDATE],
    ['delete', '/admin/promotions/:id', P.PROMOTIONS_DELETE],
    ['get', '/admin/store-banners', P.BANNERS_READ],
    ['get', '/admin/store-banners/:id', P.BANNERS_READ],
    ['post', '/admin/store-banners', P.BANNERS_CREATE],
    ['patch', '/admin/store-banners/:id', P.BANNERS_UPDATE],
    ['delete', '/admin/store-banners/:id', P.BANNERS_DELETE],
    ['get', '/admin/inventory', P.INVENTORY_READ],
    ['get', '/admin/inventory/:sku/deposit-policy/history', P.INVENTORY_READ],
    ['put', '/admin/inventory/:sku', P.INVENTORY_UPDATE],
    ['put', '/admin/products/:id/inventory/:sku', P.INVENTORY_UPDATE],
    ['get', '/admin/feedback/reports', P.FEEDBACK_READ],
    ['patch', '/admin/feedback/reviews/:id', P.FEEDBACK_MODERATE],
    ['patch', '/admin/feedback/questions/:id', P.FEEDBACK_MODERATE],
  ])('%s %s exige %s', (method, route, expected) => {
    expect(guardOf(method, route)).toBe(expected)
  })

  it('los ajustes de pagos tienen un permiso de escritura distinto del resto de ajustes', () => {
    expect(guardOf('patch', '/admin/store-payment-settings')).not.toBe(guardOf('patch', '/admin/store-currency-settings'))
  })

  it('los productos siguen con sus permisos de siempre', () => {
    expect(guardOf('get', '/admin/products')).toBe(P.PRODUCTS_READ)
    expect(guardOf('post', '/admin/products')).toBe(P.PRODUCTS_CREATE)
  })

  it('los permisos nuevos están registrados (el BFF y el catálogo los leen de aquí)', () => {
    for (const key of [
      'store.settings.read', 'store.settings.manage', 'store.payments.manage', 'promotions.read', 'promotions.create',
      'promotions.update', 'promotions.delete', 'banners.read', 'banners.create', 'banners.update', 'banners.delete',
      'feedback.read', 'feedback.moderate', 'inventory.read', 'inventory.update',
    ]) {
      expect(ALL_PERMISSION_IDS).toContain(key)
    }
  })
})

describe('migración aditiva de permisos por módulo', () => {
  it('quien leía productos conserva promociones, banners e inventario', () => {
    expect(permissionsToAdd([P.ADMIN_ACCESS, P.PRODUCTS_READ], 'skip')).toEqual(
      [P.BANNERS_READ, P.INVENTORY_READ, P.PROMOTIONS_READ].sort(),
    )
  })

  it('quien editaba productos conserva crear, editar y borrar promociones y banners, y ajustar inventario', () => {
    expect(permissionsToAdd([P.PRODUCTS_UPDATE], 'skip')).toEqual([...PRODUCT_DERIVED_GRANTS[P.PRODUCTS_UPDATE]!].sort())
  })

  it('admin.access solo concede ajustes y moderación en modo preserve', () => {
    expect(permissionsToAdd([P.ADMIN_ACCESS], 'skip')).toEqual([])
    expect(permissionsToAdd([P.ADMIN_ACCESS], 'preserve')).toEqual([...ADMIN_ACCESS_DERIVED_GRANTS[P.ADMIN_ACCESS]!].sort())
  })

  it('es idempotente y no toca listas con comodín', () => {
    const once = [P.PRODUCTS_READ, ...permissionsToAdd([P.PRODUCTS_READ], 'preserve')]
    expect(permissionsToAdd(once, 'preserve')).toEqual([])
    expect(permissionsToAdd(['*'], 'preserve')).toEqual([])
  })

  it('nunca propone quitar permisos ni conceder seguridad, usuarios o roles', () => {
    const all = permissionsToAdd([P.ADMIN_ACCESS, P.PRODUCTS_READ, P.PRODUCTS_UPDATE], 'preserve')
    expect(all.some((k) => k.startsWith('admin.'))).toBe(false)
  })
})

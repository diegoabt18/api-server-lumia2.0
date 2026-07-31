import { ALL_PERMISSION_IDS, PERMISSION_REGISTRY } from '../../../common/permissions/registry.js'

export interface ModuleSeed {
  key: string
  name: string
  description: string
  icon: string | null
  route: string | null
  section: string | null
  parentKey: string | null
  order: number
  isActive: boolean
}

export interface PermissionSeed {
  key: string
  name: string
  description: string
  moduleKey: string | null
  type: 'admin' | 'user' | 'system'
  isActive: boolean
}

export interface ServiceSeed {
  key: string
  name: string
  description: string
  httpMethod: string
  endpoint: string
  moduleKey: string | null
  permissionKey: string | null
  isActive: boolean
}

export const MODULE_SEEDS: ModuleSeed[] = [
  { key: 'dashboard', name: 'Dashboard', description: 'Panel principal', icon: 'LayoutDashboard', route: '/admin/dashboard', section: 'General', parentKey: null, order: 1, isActive: true },
  { key: 'products', name: 'Productos', description: 'Catálogo', icon: 'Package', route: '/admin/products', section: 'General', parentKey: null, order: 2, isActive: true },
  { key: 'categories', name: 'Categorías', description: 'Categorías', icon: 'Layers', route: '/admin/categories', section: 'General', parentKey: null, order: 3, isActive: true },
  { key: 'promotions', name: 'Promociones', description: 'Descuentos', icon: 'Tag', route: '/admin/promotions', section: 'General', parentKey: null, order: 4, isActive: true },
  { key: 'store-banners', name: 'Banners', description: 'Banners tienda', icon: 'Images', route: '/admin/store-banners', section: 'General', parentKey: null, order: 5, isActive: true },
  { key: 'inventory', name: 'Inventario', description: 'Stock', icon: 'Package', route: '/admin/inventory', section: 'General', parentKey: null, order: 6, isActive: true },
  { key: 'orders', name: 'Pedidos', description: 'Pedidos', icon: 'ShoppingCart', route: '/admin/orders', section: 'General', parentKey: null, order: 7, isActive: true },
  { key: 'staff-users', name: 'Staff', description: 'Usuarios staff', icon: 'Users', route: '/admin/staff-users', section: 'General', parentKey: null, order: 8, isActive: true },
  { key: 'store-settings', name: 'Tienda', description: 'Ajustes tienda', icon: 'Settings', route: '/admin/store-shipping-settings', section: 'Ajustes', parentKey: null, order: 9, isActive: true },
  { key: 'registry', name: 'Registry', description: 'Permisos y servicios', icon: 'Shield', route: '/admin/security/services', section: 'Seguridad', parentKey: null, order: 10, isActive: true },
]

const PERM_MODULE: Record<string, string> = {
  account: 'account',
  page: 'cart',
  cart: 'cart',
  orders: 'orders',
  payments: 'orders',
  products: 'products',
  categories: 'categories',
  admin: 'registry',
  analytics: 'dashboard',
  materials: 'production',
  suppliers: 'production',
  recipes: 'production',
  costing: 'production',
  production: 'production',
  units: 'production',
  equivalences: 'production',
}

function permissionType(key: string): PermissionSeed['type'] {
  if (key.startsWith('admin.') || key.includes('.manage') || key.endsWith('.delete') || key.endsWith('.create')) {
    return key.startsWith('admin.') ? 'admin' : 'admin'
  }
  return 'user'
}

export const PERMISSION_SEEDS: PermissionSeed[] = ALL_PERMISSION_IDS.map((key) => {
  const prefix = key.split('.')[0] ?? 'system'
  return {
    key,
    name: key,
    description: `Permiso ${key}`,
    moduleKey: PERM_MODULE[prefix] ?? prefix,
    type: permissionType(key),
    isActive: true,
  }
})

export const SERVICE_SEEDS: ServiceSeed[] = [
  { key: 'dashboard.stats', name: 'Stats dashboard', description: 'Estadísticas', httpMethod: 'GET', endpoint: '/api/admin/dashboard/stats', moduleKey: 'dashboard', permissionKey: PERMISSION_REGISTRY.ADMIN_ACCESS, isActive: true },
  { key: 'products.list', name: 'Listar productos', description: '', httpMethod: 'GET', endpoint: '/api/admin/products', moduleKey: 'products', permissionKey: PERMISSION_REGISTRY.PRODUCTS_READ, isActive: true },
  { key: 'products.create', name: 'Crear producto', description: '', httpMethod: 'POST', endpoint: '/api/admin/products', moduleKey: 'products', permissionKey: PERMISSION_REGISTRY.PRODUCTS_CREATE, isActive: true },
  { key: 'products.get', name: 'Detalle producto', description: '', httpMethod: 'GET', endpoint: '/api/admin/products/[id]', moduleKey: 'products', permissionKey: PERMISSION_REGISTRY.PRODUCTS_READ, isActive: true },
  { key: 'products.update', name: 'Actualizar producto', description: '', httpMethod: 'PATCH', endpoint: '/api/admin/products/[id]', moduleKey: 'products', permissionKey: PERMISSION_REGISTRY.PRODUCTS_UPDATE, isActive: true },
  { key: 'products.delete', name: 'Eliminar producto', description: '', httpMethod: 'DELETE', endpoint: '/api/admin/products/[id]', moduleKey: 'products', permissionKey: PERMISSION_REGISTRY.PRODUCTS_DELETE, isActive: true },
  { key: 'orders.list', name: 'Listar pedidos', description: '', httpMethod: 'GET', endpoint: '/api/admin/orders', moduleKey: 'orders', permissionKey: PERMISSION_REGISTRY.ORDERS_READ, isActive: true },
  { key: 'orders.get', name: 'Detalle pedido', description: '', httpMethod: 'GET', endpoint: '/api/admin/orders/[id]', moduleKey: 'orders', permissionKey: PERMISSION_REGISTRY.ORDERS_READ, isActive: true },
  { key: 'orders.update', name: 'Actualizar pedido', description: '', httpMethod: 'PATCH', endpoint: '/api/admin/orders/[id]', moduleKey: 'orders', permissionKey: PERMISSION_REGISTRY.ORDERS_UPDATE, isActive: true },
  { key: 'registry.index', name: 'Registry completo', description: '', httpMethod: 'GET', endpoint: '/api/admin/registry', moduleKey: 'registry', permissionKey: PERMISSION_REGISTRY.ADMIN_PERMISSIONS_READ, isActive: true },
  { key: 'registry.sync', name: 'Sync registry', description: '', httpMethod: 'POST', endpoint: '/api/admin/registry/sync', moduleKey: 'registry', permissionKey: PERMISSION_REGISTRY.ADMIN_PERMISSIONS_MANAGE, isActive: true },
]

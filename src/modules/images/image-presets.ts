/**
 * Presets de tamaño y claves de distribución de imágenes. Portado de lumia/shared/image-cdn.
 * Las claves (`thumb`, `small`…) son los nombres de archivo en el repositorio de imágenes/CDN: no cambiarlas.
 */
export type ImageOutputFormat = 'avif' | 'webp'

export interface ImageSizePreset {
  key: string
  width: number
  height: number
  usage: string
}

/** Productos y galería (grid → zoom). */
export const PRODUCT_SIZE_PRESETS: readonly ImageSizePreset[] = [
  { key: 'thumb', width: 100, height: 100, usage: 'Grid pequeño / carrito' },
  { key: 'small', width: 300, height: 300, usage: 'Cards móvil' },
  { key: 'medium', width: 600, height: 600, usage: 'Detalle producto' },
  { key: 'large', width: 1024, height: 1024, usage: 'Zoom desktop' },
  { key: 'big', width: 1300, height: 1300, usage: 'Alta resolución / LCP' },
] as const

/** Materiales de producción. */
export const MATERIAL_SIZE_PRESETS: readonly ImageSizePreset[] = [
  { key: 'small', width: 300, height: 300, usage: 'Listados / tablas' },
  { key: 'large', width: 1024, height: 1024, usage: 'Ficha detalle' },
] as const

/** Formatos de distribución (orden: preferido → fallback). */
export const DISTRIBUTION_FORMATS: readonly ImageOutputFormat[] = ['avif', 'webp']

/** Prefijos lógicos (imageKey) dentro del repositorio de imágenes. */
export const IMAGE_CDN_NAMESPACES = {
  products: 'products',
  materials: 'materials',
  categories: 'categories',
  banners: 'banners',
  avatars: 'avatars',
  promotions: 'promotions',
  home: 'home',
  moments: 'moments',
  history: 'history',
  logo: 'main_logo',
  other: 'other',
} as const

export function buildProductImageKey(slug: string): string {
  const s = slug.trim().toLowerCase()
  return s ? `${IMAGE_CDN_NAMESPACES.products}/${s}` : ''
}

export function buildMaterialImageKey(slug: string): string {
  const s = slug.trim().toLowerCase()
  return s ? `${IMAGE_CDN_NAMESPACES.materials}/${s}` : ''
}

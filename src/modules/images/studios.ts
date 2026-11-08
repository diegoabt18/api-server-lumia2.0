/**
 * Estudios de imagen: esquemas de configuración, slugs y nombres de archivo para producto,
 * material y sitio. Portado de lumia/shared/{product,material,site}-image-studio.ts.
 */
import { z } from 'zod'
import {
  DISTRIBUTION_FORMATS,
  IMAGE_CDN_NAMESPACES,
  MATERIAL_SIZE_PRESETS,
  PRODUCT_SIZE_PRESETS,
  type ImageOutputFormat,
} from './image-presets.js'

// ─── Configuración compartida (quality, fit, fondo) ───────────────────────────

const baseConfigShape = {
  quality: z.number().int().min(40).max(80),
  fit: z.enum(['contain', 'cover']),
  background: z.enum(['transparent', 'white', 'custom']),
  /** Solo si background === 'custom' — hex #RRGGBB */
  customHex: z.string().max(7).optional(),
  preserveAlpha: z.boolean(),
  /** No escalar por encima del original. */
  withoutEnlargement: z.boolean(),
}

export interface ImageStudioConfig {
  quality: number
  fit: 'contain' | 'cover'
  background: 'transparent' | 'white' | 'custom'
  customHex?: string
  preserveAlpha: boolean
  withoutEnlargement: boolean
}

export const DEFAULT_STUDIO_CONFIG: ImageStudioConfig = {
  quality: 60,
  fit: 'contain',
  background: 'white',
  customHex: '#ffffff',
  preserveAlpha: false,
  withoutEnlargement: true,
}

// ─── Producto ────────────────────────────────────────────────────────────────

export const PRODUCT_IMAGE_FORMATS = PRODUCT_SIZE_PRESETS.map((p) => ({
  key: p.key,
  width: p.width,
  height: p.height,
  usage: p.usage,
}))

export const productImageStudioConfigSchema = z.object(baseConfigShape)
export type ProductImageStudioConfig = z.infer<typeof productImageStudioConfigSchema>

export function sanitizeProductSlug(input: string): string | null {
  const s = input.trim().toLowerCase()
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s)) return null
  return s
}

export function productFilename(params: {
  slug: string
  formatKey: string
  role: 'main' | 'gallery'
  galleryIndex?: number
  format?: ImageOutputFormat
}): string {
  const format = params.format ?? 'avif'
  if (params.role === 'main') return `${params.slug}-${params.formatKey}.${format}`
  return `${params.slug}-gallery-${params.galleryIndex ?? 1}-${params.formatKey}.${format}`
}

/** Ruta determinística dentro del repositorio de imágenes. */
export function productExportPath(params: Parameters<typeof productFilename>[0]): string {
  return `products/${params.slug}/${productFilename(params)}`
}

// ─── Material ────────────────────────────────────────────────────────────────

export const MATERIAL_IMAGE_FORMATS = MATERIAL_SIZE_PRESETS.map((p) => ({
  key: p.key,
  width: p.width,
  height: p.height,
  usage: p.usage,
}))

export const materialImageStudioConfigSchema = z.object(baseConfigShape)
export type MaterialImageStudioConfig = z.infer<typeof materialImageStudioConfigSchema>

/** Sanitiza un nombre de material para usarlo como slug de archivo. "Aceite de Coco" → "aceite-de-coco". */
export function sanitizeMaterialSlug(input: string): string | null {
  const cleaned = input.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (!cleaned || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(cleaned)) return null
  return cleaned
}

export function materialFilename(slug: string, formatKey: string, format: ImageOutputFormat = 'avif'): string {
  return `${slug}-${formatKey}.${format}`
}

export function materialExportPath(slug: string, formatKey: string, format: ImageOutputFormat = 'avif'): string {
  return `materials/${slug}/${materialFilename(slug, formatKey, format)}`
}

// ─── Sitio ───────────────────────────────────────────────────────────────────

export type SiteImageKind = 'logo' | 'home' | 'history' | 'moments'

export interface SiteImageKindMeta {
  kind: SiteImageKind
  folder: string
  numbered: boolean
  maxIndex: number
  fixedBasename: string
  presets: readonly { key: string; width: number; height: number; usage: string }[]
  defaultFit: 'contain' | 'cover'
  defaultBackground: 'transparent' | 'white' | 'custom'
}

export const SITE_IMAGE_KINDS: Record<SiteImageKind, SiteImageKindMeta> = {
  logo: {
    kind: 'logo',
    folder: IMAGE_CDN_NAMESPACES.logo,
    numbered: false,
    maxIndex: 1,
    fixedBasename: 'logo',
    presets: [{ key: 'default', width: 512, height: 512, usage: 'Navbar / cabecera' }],
    defaultFit: 'contain',
    defaultBackground: 'transparent',
  },
  home: {
    kind: 'home',
    folder: IMAGE_CDN_NAMESPACES.home,
    numbered: true,
    maxIndex: 8,
    fixedBasename: 'image',
    presets: [{ key: 'hero', width: 1920, height: 1080, usage: 'Hero full-bleed desktop' }],
    defaultFit: 'cover',
    defaultBackground: 'white',
  },
  history: {
    kind: 'history',
    folder: IMAGE_CDN_NAMESPACES.history,
    numbered: false,
    maxIndex: 1,
    fixedBasename: 'image',
    presets: [{ key: 'default', width: 1200, height: 1500, usage: 'Bloque editorial home' }],
    defaultFit: 'cover',
    defaultBackground: 'white',
  },
  moments: {
    kind: 'moments',
    folder: IMAGE_CDN_NAMESPACES.moments,
    numbered: true,
    maxIndex: 12,
    fixedBasename: 'image',
    presets: [{ key: 'square', width: 800, height: 800, usage: 'Cuadrícula Instagram' }],
    defaultFit: 'cover',
    defaultBackground: 'white',
  },
}

export const siteImageKindSchema = z.enum(['logo', 'home', 'history', 'moments'])
export const siteImageStudioConfigSchema = z.object(baseConfigShape)

export function defaultSiteStudioConfig(kind: SiteImageKind): ImageStudioConfig {
  const meta = SITE_IMAGE_KINDS[kind]
  return {
    quality: 60,
    fit: meta.defaultFit,
    background: meta.defaultBackground,
    customHex: '#ffffff',
    preserveAlpha: meta.defaultBackground === 'transparent',
    withoutEnlargement: true,
  }
}

export function siteImageBasename(kind: SiteImageKind, index: number | null): string {
  const meta = SITE_IMAGE_KINDS[kind]
  return meta.numbered ? `image_${index ?? 1}` : meta.fixedBasename
}

export function siteFilename(kind: SiteImageKind, index: number | null, format: ImageOutputFormat): string {
  return `${siteImageBasename(kind, index)}.${format}`
}

export function siteExportPath(kind: SiteImageKind, index: number | null, format: ImageOutputFormat): string {
  return `${SITE_IMAGE_KINDS[kind].folder}/${siteFilename(kind, index, format)}`
}

export { DISTRIBUTION_FORMATS }

/**
 * Generación AVIF + WebP de imágenes de producto, material y sitio. Portado de Lumia
 * (generate-*-images.ts). Recibe archivos ya leídos del multipart; no conoce HTTP.
 * Devuelve las mismas formas de respuesta que el backend embebido, para no romper Lumia.
 */
import { AppError } from '../../common/errors/app.error.js'
import { DISTRIBUTION_FORMATS, buildMaterialImageKey, buildProductImageKey, type ImageOutputFormat } from './image-presets.js'
import {
  DEFAULT_STUDIO_CONFIG,
  MATERIAL_IMAGE_FORMATS,
  PRODUCT_IMAGE_FORMATS,
  SITE_IMAGE_KINDS,
  defaultSiteStudioConfig,
  materialExportPath,
  materialFilename,
  materialImageStudioConfigSchema,
  productExportPath,
  productFilename,
  productImageStudioConfigSchema,
  sanitizeMaterialSlug,
  sanitizeProductSlug,
  siteExportPath,
  siteFilename,
  siteImageBasename,
  siteImageKindSchema,
  siteImageStudioConfigSchema,
  type ImageStudioConfig,
  type SiteImageKind,
} from './studios.js'
import { assertValidImageUpload, compressionPercent, renderImageVariant } from './sharp-renderer.js'

export interface UploadedImage {
  data: Buffer
  mimetype?: string
  filename: string
}

export interface GeneratedVariant {
  key: string
  format: ImageOutputFormat
  filename: string
  exportPath: string
  usage: string
  width: number
  height: number
  inputBytes: number
  outputBytes: number
  compressionPercent: number
  base64: string
}

const MAX_PRODUCT_FILE_BYTES = 12 * 1024 * 1024
const MAX_MATERIAL_FILE_BYTES = 12 * 1024 * 1024
const MAX_SITE_FILE_BYTES = 16 * 1024 * 1024
const MAX_GALLERY = 8

const HEX_PATTERN = /^#?[0-9a-fA-F]{6}$/

/** Parsea y valida la configuración JSON del estudio; si no llega, usa los valores por defecto. */
function parseStudioConfig(
  raw: string | undefined,
  schema: { safeParse: (v: unknown) => { success: true; data: ImageStudioConfig } | { success: false } },
  defaults: ImageStudioConfig,
): ImageStudioConfig {
  if (!raw || !raw.trim()) return defaults
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw AppError.badRequest('JSON de configuración inválido')
  }
  const result = schema.safeParse(parsed)
  if (!result.success) throw AppError.badRequest('Configuración inválida')
  return result.data
}

function assertCustomHex(config: ImageStudioConfig): void {
  if (config.background !== 'custom') return
  const hex = config.customHex?.trim()
  if (!hex || !HEX_PATTERN.test(hex)) throw AppError.badRequest('customHex debe ser #RRGGBB')
}

function toVariantDto(params: {
  key: string
  format: ImageOutputFormat
  filename: string
  exportPath: string
  usage: string
  width: number
  height: number
  inputBytes: number
  buffer: Buffer
}): GeneratedVariant {
  return {
    key: params.key,
    format: params.format,
    filename: params.filename,
    exportPath: params.exportPath,
    usage: params.usage,
    width: params.width,
    height: params.height,
    inputBytes: params.inputBytes,
    outputBytes: params.buffer.length,
    compressionPercent: compressionPercent(params.inputBytes, params.buffer.length),
    base64: params.buffer.toString('base64'),
  }
}

// ─── Producto ────────────────────────────────────────────────────────────────

export async function generateProductImages(input: {
  slug: string
  configJson?: string
  main: UploadedImage | undefined
  gallery: UploadedImage[]
}) {
  const slug = sanitizeProductSlug(input.slug)
  if (!slug) throw AppError.badRequest('Slug inválido (solo minúsculas y guiones)')
  if (!input.main) throw AppError.badRequest('Debe subir exactamente una imagen principal')
  if (input.gallery.length > MAX_GALLERY) {
    throw AppError.badRequest(`Máximo ${MAX_GALLERY} imágenes en galería`)
  }

  const config = parseStudioConfig(input.configJson, productImageStudioConfigSchema, DEFAULT_STUDIO_CONFIG)
  assertCustomHex(config)

  await assertValidImageUpload({ data: input.main.data, declaredMime: input.main.mimetype, filename: input.main.filename || 'principal', maxBytes: MAX_PRODUCT_FILE_BYTES })
  for (const g of input.gallery) {
    await assertValidImageUpload({ data: g.data, declaredMime: g.mimetype, filename: g.filename || 'galería', maxBytes: MAX_PRODUCT_FILE_BYTES })
  }

  const mainBytes = input.main.data.length
  const main: GeneratedVariant[] = []
  for (const spec of PRODUCT_IMAGE_FORMATS) {
    for (const format of DISTRIBUTION_FORMATS) {
      const r = await renderImageVariant({ input: input.main.data, spec, config, format })
      main.push(toVariantDto({
        key: spec.key,
        format,
        filename: productFilename({ slug, formatKey: spec.key, role: 'main', format }),
        exportPath: productExportPath({ slug, formatKey: spec.key, role: 'main', format }),
        usage: spec.usage,
        width: r.width,
        height: r.height,
        inputBytes: mainBytes,
        buffer: r.buffer,
      }))
    }
  }

  const gallery: GeneratedVariant[][] = []
  let galleryIndex = 1
  for (const g of input.gallery) {
    const row: GeneratedVariant[] = []
    for (const spec of PRODUCT_IMAGE_FORMATS) {
      for (const format of DISTRIBUTION_FORMATS) {
        const r = await renderImageVariant({ input: g.data, spec, config, format })
        row.push(toVariantDto({
          key: spec.key,
          format,
          filename: productFilename({ slug, formatKey: spec.key, role: 'gallery', galleryIndex, format }),
          exportPath: productExportPath({ slug, formatKey: spec.key, role: 'gallery', galleryIndex, format }),
          usage: spec.usage,
          width: r.width,
          height: r.height,
          inputBytes: g.data.length,
          buffer: r.buffer,
        }))
      }
    }
    gallery.push(row)
    galleryIndex += 1
  }

  return { slug, imageKey: buildProductImageKey(slug), main, gallery }
}

// ─── Material ────────────────────────────────────────────────────────────────

export async function generateMaterialImages(input: {
  slug: string
  configJson?: string
  image: UploadedImage | undefined
}) {
  const slug = sanitizeMaterialSlug(input.slug)
  if (!slug) throw AppError.badRequest('Slug inválido (solo minúsculas y guiones)')
  if (!input.image) throw AppError.badRequest('Debe subir una imagen')

  const config = parseStudioConfig(input.configJson, materialImageStudioConfigSchema, DEFAULT_STUDIO_CONFIG)
  assertCustomHex(config)

  await assertValidImageUpload({ data: input.image.data, declaredMime: input.image.mimetype, filename: input.image.filename || 'imagen', maxBytes: MAX_MATERIAL_FILE_BYTES })

  const inputBytes = input.image.data.length
  const variants: GeneratedVariant[] = []
  for (const spec of MATERIAL_IMAGE_FORMATS) {
    for (const format of DISTRIBUTION_FORMATS) {
      const r = await renderImageVariant({ input: input.image.data, spec, config, format })
      variants.push(toVariantDto({
        key: spec.key,
        format,
        filename: materialFilename(slug, spec.key, format),
        exportPath: materialExportPath(slug, spec.key, format),
        usage: spec.usage,
        width: r.width,
        height: r.height,
        inputBytes,
        buffer: r.buffer,
      }))
    }
  }
  return { slug, imageKey: buildMaterialImageKey(slug), variants }
}

// ─── Sitio ───────────────────────────────────────────────────────────────────

export async function generateSiteImages(input: {
  kind: string
  index?: string
  configJson?: string
  image: UploadedImage | undefined
}) {
  const kindParsed = siteImageKindSchema.safeParse(input.kind.trim())
  if (!kindParsed.success) throw AppError.badRequest('Tipo de imagen inválido')
  const kind: SiteImageKind = kindParsed.data
  const meta = SITE_IMAGE_KINDS[kind]

  let index: number | null = null
  if (meta.numbered) {
    const parsed = Number(input.index ?? '')
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > meta.maxIndex) {
      throw AppError.badRequest(`Índice inválido (1–${meta.maxIndex})`)
    }
    index = parsed
  }

  if (!input.image) throw AppError.badRequest('Debe subir una imagen')

  const config = parseStudioConfig(input.configJson, siteImageStudioConfigSchema, defaultSiteStudioConfig(kind))
  assertCustomHex(config)

  await assertValidImageUpload({ data: input.image.data, declaredMime: input.image.mimetype, filename: input.image.filename || 'imagen', maxBytes: MAX_SITE_FILE_BYTES })

  const inputBytes = input.image.data.length
  const preset = meta.presets[0]!
  const variants: GeneratedVariant[] = []
  for (const format of DISTRIBUTION_FORMATS) {
    const r = await renderImageVariant({ input: input.image.data, spec: preset, config, format })
    variants.push(toVariantDto({
      key: preset.key,
      format,
      filename: siteFilename(kind, index, format),
      exportPath: siteExportPath(kind, index, format),
      usage: preset.usage,
      width: r.width,
      height: r.height,
      inputBytes,
      buffer: r.buffer,
    }))
  }
  return { kind, folder: meta.folder, index, basename: siteImageBasename(kind, index), variants }
}

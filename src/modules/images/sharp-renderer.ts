/**
 * Renderizado de imágenes con Sharp (AVIF / WebP) y validación de subidas.
 * Portado de lumia/server/utils/product-image-sharp.ts. La lógica de imagen no cambia;
 * los errores son AppError en lugar de errores de h3.
 */
import type { Sharp } from 'sharp'
import { AppError } from '../../common/errors/app.error.js'
import type { ImageOutputFormat } from './image-presets.js'
import type { ImageStudioConfig } from './studios.js'

type ImageFormatSpec = { width: number; height: number }
const MAX_INPUT_PIXELS = 50_000_000

type SharpFactory = typeof import('sharp')

/** Carga perezosa: evita inicializar libvips al arrancar el servidor. */
let factory: SharpFactory | null = null

/** Acepta la fábrica como default export o como módulo directo, según cómo empaquete el runtime. */
async function getSharp(): Promise<SharpFactory> {
  if (!factory) {
    const mod = (await import('sharp')) as unknown as { default?: SharpFactory } & SharpFactory
    const resolved = mod.default ?? mod
    resolved.concurrency(1)
    resolved.cache(false)
    factory = resolved
  }
  return factory
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.trim().replace(/^#/, '')
  if (h.length !== 6 || !/^[0-9a-fA-F]+$/.test(h)) {
    throw AppError.badRequest('Hex inválido (usa #RRGGBB)')
  }
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  }
}

function resolveBackground(cfg: ImageStudioConfig): { r: number; g: number; b: number } | null {
  if (cfg.background === 'transparent') return null
  if (cfg.background === 'white') return { r: 255, g: 255, b: 255 }
  const hex = cfg.customHex?.trim() || '#ffffff'
  return hexToRgb(hex.startsWith('#') ? hex : `#${hex}`)
}

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif', 'image/tiff'])

/** Detecta el tipo real por bytes de cabecera (no confiar solo en Content-Type). */
export function detectImageMimeFromBuffer(buf: Buffer): string | null {
  if (!buf || buf.length < 12) return null

  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif'
  if (
    (buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00) ||
    (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a)
  ) {
    return 'image/tiff'
  }
  // RIFF....WEBP
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return 'image/webp'
  }
  // ISO BMFF (AVIF): ....ftyp + marca avif/avis
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
    const brand = buf.subarray(8, 12).toString('ascii')
    if (brand.startsWith('avif') || brand.startsWith('avis') || brand.includes('av1')) return 'image/avif'
  }

  // SVG / XML: se rechaza siempre (XSS y bombas de entidades).
  const head = buf.subarray(0, Math.min(256, buf.length)).toString('utf8').trimStart().toLowerCase()
  if (head.startsWith('<svg') || head.startsWith('<?xml') || head.startsWith('<!doctype svg')) {
    return 'image/svg+xml'
  }
  return null
}

/**
 * Valida tamaño, tipo real por bytes, MIME declarado y dimensiones (anti image-bomb).
 * SVG nunca se acepta.
 */
export async function assertValidImageUpload(params: {
  data: Buffer
  declaredMime?: string
  filename: string
  maxBytes: number
  maxPixels?: number
}): Promise<{ mime: string; width: number; height: number }> {
  const { data, declaredMime, filename, maxBytes } = params
  const maxPixels = params.maxPixels ?? MAX_INPUT_PIXELS

  if (!data?.length) throw AppError.badRequest(`Archivo vacío: ${filename}`)
  if (data.length > maxBytes) {
    throw new AppError(413, `Archivo demasiado grande (máx ${Math.round(maxBytes / (1024 * 1024))}MB): ${filename}`)
  }

  const magic = detectImageMimeFromBuffer(data)
  if (!magic || magic === 'image/svg+xml') {
    throw AppError.badRequest(`Tipo de archivo no permitido o corrupto (${filename}). Solo JPEG/PNG/WebP/AVIF/GIF/TIFF.`)
  }

  const declared = (declaredMime || '').toLowerCase().split(';')[0]?.trim()
  // Algunos clientes envían application/octet-stream: solo se rechaza otro image/* declarado.
  if (declared && ALLOWED_MIME.has(declared) && declared !== magic && declared.startsWith('image/')) {
    throw AppError.badRequest(`MIME declarado (${declared}) no coincide con el contenido (${magic}): ${filename}`)
  }

  const sharp = await getSharp()
  let meta: { width?: number; height?: number }
  try {
    meta = await sharp(data, { failOn: 'none', limitInputPixels: maxPixels }).metadata()
  } catch {
    throw AppError.badRequest(`Imagen corrupta o no legible: ${filename}`)
  }

  const width = meta.width ?? 0
  const height = meta.height ?? 0
  if (width < 1 || height < 1) throw AppError.badRequest(`Dimensiones inválidas: ${filename}`)
  if (width * height > maxPixels) {
    throw AppError.badRequest(`Imagen demasiado grande en píxeles (${width}×${height}): ${filename}`)
  }
  return { mime: magic, width, height }
}

async function buildResizePipeline(params: {
  input: Buffer
  spec: ImageFormatSpec
  config: ImageStudioConfig
}): Promise<Sharp> {
  const { input, spec, config } = params
  const sharp = await getSharp()
  const meta = await sharp(input, { failOn: 'none', limitInputPixels: MAX_INPUT_PIXELS }).metadata()
  const hadAlpha = meta.hasAlpha === true

  let pipeline: Sharp = sharp(input, { failOn: 'none', limitInputPixels: MAX_INPUT_PIXELS })
    .rotate()
    .resize(spec.width, spec.height, {
      fit: config.fit === 'cover' ? 'cover' : 'inside',
      position: config.fit === 'cover' ? 'attention' : 'centre',
      withoutEnlargement: config.withoutEnlargement,
    })

  const wantTransparency = config.background === 'transparent' || (config.preserveAlpha && hadAlpha)
  if (!wantTransparency) {
    const bg = resolveBackground(config)
    if (bg) pipeline = pipeline.flatten({ background: bg })
  }
  return pipeline
}

/** Genera una variante optimizada (AVIF o WebP) sin deformar la imagen. */
export async function renderImageVariant(params: {
  input: Buffer
  spec: ImageFormatSpec
  config: ImageStudioConfig
  format: ImageOutputFormat
}): Promise<{ buffer: Buffer; width: number; height: number }> {
  const { input, spec, config, format } = params
  const pipeline = await buildResizePipeline({ input, spec, config })
  const encoded =
    format === 'webp'
      ? pipeline.webp({ quality: config.quality, effort: 4 })
      : pipeline.avif({ quality: config.quality, effort: 2, chromaSubsampling: '4:2:0' })

  const { data, info } = await encoded.toBuffer({ resolveWithObject: true })
  return { buffer: data, width: info.width ?? spec.width, height: info.height ?? spec.height }
}

export function compressionPercent(inputBytes: number, outputBytes: number): number {
  if (inputBytes <= 0) return 0
  const raw = (1 - outputBytes / inputBytes) * 100
  return Math.max(0, Math.min(100, Math.round(raw)))
}

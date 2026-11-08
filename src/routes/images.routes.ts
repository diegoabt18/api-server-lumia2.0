import type { FastifyInstance, FastifyRequest } from 'fastify'
import multipart from '@fastify/multipart'
import type { AppContext } from '../app.context.js'
import { AppError } from '../common/errors/app.error.js'
import { PERMISSION_REGISTRY } from '../common/permissions/registry.js'
import { adminGuard } from '../modules/admin/middleware/admin-guard.js'
import {
  generateMaterialImages,
  generateProductImages,
  generateSiteImages,
  type UploadedImage,
} from '../modules/images/image-generation.service.js'

const MAX_FILE_BYTES = 16 * 1024 * 1024
const MAX_FILES_PER_REQUEST = 12

interface ParsedMultipart {
  fields: Record<string, string>
  files: Record<string, UploadedImage[]>
}

/** Lee todas las partes del multipart. Los archivos se guardan en memoria (límite por archivo). */
async function readMultipart(request: FastifyRequest): Promise<ParsedMultipart> {
  const parsed: ParsedMultipart = { fields: {}, files: {} }
  let count = 0
  for await (const part of request.parts()) {
    count += 1
    if (count > MAX_FILES_PER_REQUEST + 10) throw AppError.badRequest('Demasiadas partes en la solicitud')
    if (part.type === 'file') {
      const data = await part.toBuffer()
      if (!part.filename || !data.length) continue
      const bucket = (parsed.files[part.fieldname] ??= [])
      bucket.push({ data, mimetype: part.mimetype, filename: part.filename })
    } else {
      parsed.fields[part.fieldname] = String(part.value ?? '')
    }
  }
  if (count === 0) throw AppError.badRequest('Multipart vacío')
  return parsed
}

/**
 * Generación de imágenes (producto, sitio y materiales). Antes corría en Nitro de Lumia; ahora
 * el servidor es el único que procesa y devuelve las variantes. Lumia solo reenvía la solicitud.
 */
export async function registerImageRoutes(api: FastifyInstance, ctx: AppContext) {
  const g = (permission: (typeof PERMISSION_REGISTRY)[keyof typeof PERMISSION_REGISTRY]) =>
    adminGuard(ctx.repos.sessions, permission, ctx.services.authorization)

  await api.register(multipart, {
    limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES_PER_REQUEST, fields: 20 },
  })

  api.post('/admin/product-images/generate', { preHandler: g(PERMISSION_REGISTRY.PRODUCTS_UPDATE) }, async (request) => {
    const { fields, files } = await readMultipart(request)
    const main = files['main']
    if (main && main.length !== 1) throw AppError.badRequest('Debe subir exactamente una imagen principal')
    return generateProductImages({
      slug: fields['slug'] ?? '',
      configJson: fields['config'],
      main: main?.[0],
      gallery: files['gallery'] ?? [],
    })
  })

  api.post('/admin/site-images/generate', { preHandler: g(PERMISSION_REGISTRY.PRODUCTS_UPDATE) }, async (request) => {
    const { fields, files } = await readMultipart(request)
    return generateSiteImages({
      kind: fields['kind'] ?? '',
      index: fields['index'],
      configJson: fields['config'],
      image: files['image']?.[0],
    })
  })

  api.post('/admin/production/materials/images/generate', { preHandler: g(PERMISSION_REGISTRY.MATERIALS_UPDATE) }, async (request) => {
    const { fields, files } = await readMultipart(request)
    return generateMaterialImages({
      slug: fields['slug'] ?? '',
      configJson: fields['config'],
      image: files['image']?.[0],
    })
  })
}

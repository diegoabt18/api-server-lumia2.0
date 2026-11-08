import { describe, it, expect } from 'vitest'
import sharp from 'sharp'
import { detectImageMimeFromBuffer, assertValidImageUpload, renderImageVariant } from '../../src/modules/images/sharp-renderer.js'
import { generateProductImages, generateMaterialImages, generateSiteImages } from '../../src/modules/images/image-generation.service.js'
import { PRODUCT_IMAGE_FORMATS, productExportPath, sanitizeProductSlug, materialExportPath, siteExportPath } from '../../src/modules/images/studios.js'
import { isAppError } from '../../src/common/errors/app.error.js'

async function png(width = 800, height = 600): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 50, b: 50 } } }).png().toBuffer()
}

async function expectStatus(promise: Promise<unknown>, status: number) {
  const err = await promise.catch((e: unknown) => e)
  expect(isAppError(err)).toBe(true)
  expect((err as { statusCode: number }).statusCode).toBe(status)
}

describe('image signature detection', () => {
  it('identifies PNG by magic bytes and rejects SVG and unknown data', async () => {
    expect(detectImageMimeFromBuffer(await png())).toBe('image/png')
    expect(detectImageMimeFromBuffer(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe('image/svg+xml')
    expect(detectImageMimeFromBuffer(Buffer.from('nope, no es una imagen de ninguna clase'))).toBeNull()
  })
})

describe('upload validation', () => {
  it('accepts a real PNG and reports its dimensions', async () => {
    const res = await assertValidImageUpload({ data: await png(), declaredMime: 'image/png', filename: 'a.png', maxBytes: 1_000_000 })
    expect(res).toMatchObject({ mime: 'image/png', width: 800, height: 600 })
  })

  it('rejects empty, oversized and SVG uploads', async () => {
    await expectStatus(assertValidImageUpload({ data: Buffer.alloc(0), filename: 'v.png', maxBytes: 10 }), 400)
    await expectStatus(assertValidImageUpload({ data: await png(), filename: 'g.png', maxBytes: 10 }), 413)
    await expectStatus(
      assertValidImageUpload({ data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), filename: 's.svg', maxBytes: 1000 }),
      400,
    )
  })

  it('rejects a declared image type that does not match the content', async () => {
    await expectStatus(
      assertValidImageUpload({ data: await png(), declaredMime: 'image/jpeg', filename: 'x.jpg', maxBytes: 1_000_000 }),
      400,
    )
  })
})

describe('variant rendering', () => {
  it('renders WebP within the preset box without enlarging', async () => {
    const spec = PRODUCT_IMAGE_FORMATS.find((s) => s.key === 'medium')!
    const r = await renderImageVariant({
      input: await png(800, 600),
      spec,
      config: { quality: 60, fit: 'contain', background: 'white', customHex: '#ffffff', preserveAlpha: false, withoutEnlargement: true },
      format: 'webp',
    })
    expect(r.width).toBeLessThanOrEqual(600)
    expect(r.height).toBeLessThanOrEqual(600)
    expect((await sharp(r.buffer).metadata()).format).toBe('webp')
  })

  it('renders AVIF output', async () => {
    const spec = PRODUCT_IMAGE_FORMATS.find((s) => s.key === 'thumb')!
    const r = await renderImageVariant({
      input: await png(),
      spec,
      config: { quality: 60, fit: 'cover', background: 'white', customHex: '#ffffff', preserveAlpha: false, withoutEnlargement: true },
      format: 'avif',
    })
    expect(r.width).toBe(100)
    expect(r.height).toBe(100)
    expect((await sharp(r.buffer).metadata()).format).toBe('heif')
  })
})

describe('generation flows', () => {
  it('generates 5 sizes in AVIF and WebP for a product with its export paths', async () => {
    const res = await generateProductImages({
      slug: 'vela-lavanda',
      main: { data: await png(), mimetype: 'image/png', filename: 'vela.png' },
      gallery: [],
    })
    expect(res.imageKey).toBe('products/vela-lavanda')
    expect(res.main).toHaveLength(PRODUCT_IMAGE_FORMATS.length * 2)
    const thumbAvif = res.main.find((v) => v.key === 'thumb' && v.format === 'avif')!
    expect(thumbAvif.exportPath).toBe(productExportPath({ slug: 'vela-lavanda', formatKey: 'thumb', role: 'main', format: 'avif' }))
    expect(thumbAvif.exportPath).toBe('products/vela-lavanda/vela-lavanda-thumb.avif')
  })

  it('requires exactly one main image for products', async () => {
    await expectStatus(generateProductImages({ slug: 'vela', main: undefined, gallery: [] }), 400)
  })

  it('rejects an invalid product slug and an invalid studio configuration', async () => {
    const main = { data: await png(), mimetype: 'image/png', filename: 'v.png' }
    await expectStatus(generateProductImages({ slug: 'Vela Mala!', main, gallery: [] }), 400)
    await expectStatus(generateProductImages({ slug: 'vela', main, gallery: [], configJson: '{"quality":999}' }), 400)
    await expectStatus(
      generateProductImages({ slug: 'vela', main, gallery: [], configJson: '{"quality":60,"fit":"contain","background":"custom","customHex":"#zzz","preserveAlpha":false,"withoutEnlargement":true}' }),
      400,
    )
  })

  it('generates material images in 2 sizes and 2 formats', async () => {
    const res = await generateMaterialImages({ slug: 'aceite-de-coco', image: { data: await png(), mimetype: 'image/png', filename: 'a.png' } })
    expect(res.variants).toHaveLength(4)
    expect(res.variants[0]!.exportPath).toBe(materialExportPath('aceite-de-coco', 'small', 'avif'))
  })

  it('requires a valid index for numbered site images', async () => {
    const image = { data: await png(), mimetype: 'image/png', filename: 'h.png' }
    await expectStatus(generateSiteImages({ kind: 'home', index: undefined, image }), 400)
    await expectStatus(generateSiteImages({ kind: 'home', index: '9', image }), 400)
    await expectStatus(generateSiteImages({ kind: 'desconocido', index: '1', image }), 400)
    const ok = await generateSiteImages({ kind: 'home', index: '2', image })
    expect(ok.basename).toBe('image_2')
    expect(ok.variants[0]!.exportPath).toBe(siteExportPath('home', 2, 'avif'))
  })

  it('keeps the slug sanitizer strict for products', () => {
    expect(sanitizeProductSlug('vela-lavanda')).toBe('vela-lavanda')
    expect(sanitizeProductSlug('Vela Lavanda')).toBeNull()
  })
})

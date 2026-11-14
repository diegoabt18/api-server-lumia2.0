import { z } from 'zod'

/**
 * Validación de la configuración de la tienda (envíos, moneda, atención al cliente).
 * Antes se guardaba el cuerpo tal cual con $set: cualquier clave o tipo llegaba a la base y a la
 * tienda. Los campos desconocidos se descartan (no se rechazan) para no romper clientes antiguos.
 * Límites alineados con Lumia Admin (shared/schemas/settings.ts).
 */

const text = (max: number) => z.string().trim().max(max)
const money = z.number().int().min(0).max(1_000_000_000)

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password
  } catch {
    return false
  }
}

/** Ruta interna: una sola "/" inicial, sin barras invertidas, espacios ni caracteres de control. */
export function isInternalPath(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /^\/(?!\/)[^\s\\]*$/.test(value) && !/[\u0000-\u001f\u007f]/.test(value)
}

/** Enlace publicado en la tienda: ruta interna o https (nunca javascript:, data: ni //host). */
export const safeLinkHref = z
  .string()
  .trim()
  .max(2000)
  .refine((v) => isInternalPath(v) || isHttpsUrl(v), 'Usa una ruta interna o una URL https://')

export const safeImageUrl = z.string().trim().max(2000).refine(isHttpsUrl, 'Usa una URL https://')

const shippingMessagesSchema = z
  .object({
    remainingMessage: text(300),
    freeShippingMessage: text(300),
    shippingCostMessage: text(300),
    variableShippingMessage: text(300),
    progressBarMessage: text(300),
    progressBarCompleteMessage: text(300),
  })
  .partial()

export const shippingSettingsBodySchema = z.object({
  shippingEnabled: z.boolean(),
  freeShippingEnabled: z.boolean(),
  freeShippingThreshold: money,
  // Solo la tarifa plana está implementada en el Server y en la tienda.
  calculationType: z.literal('flat_rate').default('flat_rate'),
  flatRateEnabled: z.boolean(),
  flatRate: money,
  applyThresholdOn: z.enum(['subtotal', 'total_before_taxes', 'total_final']),
  showProgressBar: z.boolean(),
  showMessages: z.boolean(),
  messages: shippingMessagesSchema.default({}),
})

export const currencySettingsPatchSchema = z
  .object({
    name: text(60).min(1),
    code: z.string().trim().regex(/^[A-Z]{3}$/),
    symbol: text(5).min(1),
    prefix: text(10),
    suffix: text(10),
    decimalPlaces: z.number().int().min(0).max(4),
    decimalSeparator: z.enum([',', '.']),
    thousandsSeparator: z.enum(['.', ',', ' ', '']),
    spaceBetween: z.boolean(),
    symbolPosition: z.enum(['before', 'after']),
    showCode: z.boolean(),
  })
  .partial()

const faqItemSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  question: text(300).min(1),
  answer: text(2000).min(1),
})

export const customerSettingsPatchSchema = z
  .object({
    supportWhatsappPhone: z
      .string()
      .trim()
      .refine((v) => v === '' || /^\d{8,15}$/.test(v), 'Teléfono inválido'),
    contactEmail: z
      .string()
      .trim()
      .max(254)
      .refine((v) => v === '' || z.string().email().safeParse(v).success, 'Correo inválido'),
    faqItems: z.array(faqItemSchema).max(30),
    policiesContent: text(20000),
    policiesUrl: z.union([safeLinkHref, z.literal('')]),
    termsContent: text(20000),
    termsUrl: z.union([safeLinkHref, z.literal('')]),
    promotionTooltipDelayMs: z.number().int().min(0).max(5000),
  })
  .partial()

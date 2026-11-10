import { z } from 'zod'

/**
 * Política de anticipo de un SKU fabricado bajo pedido (`made_to_order`).
 *
 * Unidades: importes en la moneda del pedido, con dos decimales como máximo.
 *  - `fixed`: importe fijo POR UNIDAD del SKU.
 *  - `percent`: porcentaje (0 < v ≤ 100) sobre el total de la línea.
 *  - `materials`: porcentaje (0 < v ≤ 100) sobre el costo de materiales de la línea.
 *  - `custom_authorized`: importe POR UNIDAD fijado manualmente; exige autorización trazable.
 *
 * Los valores por defecto siguen pendientes (decisión D1): no hay política predeterminada.
 * `null`/ausente significa "sin política configurada" y el cálculo de pedidos la rechaza.
 */
export const DEPOSIT_POLICY_TYPES = ['fixed', 'percent', 'materials', 'custom_authorized'] as const
export type DepositPolicyType = (typeof DEPOSIT_POLICY_TYPES)[number]

export interface DepositAuthorization {
  /**
   * Usuario autenticado que guardó la política. Server lo fija desde la sesión: el valor
   * enviado por el navegador se sustituye, nunca se persiste tal cual.
   */
  authorizedBy: string
  /** Motivo de la excepción, para trazabilidad. */
  reason: string
  /** Momento en que Server registró la autorización. */
  authorizedAt?: Date
}

export interface DepositPolicy {
  type: DepositPolicyType
  value: number
  authorization?: DepositAuthorization
}

const hasAtMostTwoDecimals = (n: number) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6

/**
 * Entrada: el navegador envía solo el motivo. `authorizedBy` lo fija Server desde la sesión; si el
 * cliente lo envía, se ignora. Las políticas almacenadas siempre lo tienen.
 */
const depositAuthorizationSchema = z.object({
  authorizedBy: z.string().trim().max(120).optional(),
  reason: z.string().trim().min(1).max(500),
})

export const depositPolicySchema = z
  .object({
    type: z.enum(DEPOSIT_POLICY_TYPES),
    value: z
      .number()
      .finite()
      .positive('El valor debe ser mayor que cero.')
      .refine(hasAtMostTwoDecimals, 'Admite como máximo dos decimales.'),
    // `null` llega de documentos guardados antes de este cambio (Mongo convierte undefined en null).
    authorization: depositAuthorizationSchema.nullable().optional(),
  })
  .superRefine((policy, ctx) => {
    if ((policy.type === 'percent' || policy.type === 'materials') && policy.value > 100) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: 'El porcentaje no puede superar 100.' })
    }
    if (policy.type === 'custom_authorized' && !policy.authorization) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['authorization'],
        message: 'El anticipo personalizado requiere autorización (quién autoriza y motivo).',
      })
    }
    if (policy.type !== 'custom_authorized' && policy.authorization) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['authorization'],
        message: 'Solo el anticipo personalizado admite autorización.',
      })
    }
  })

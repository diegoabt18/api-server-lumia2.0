import { z } from 'zod'

const posCustomerSchema = z
  .object({
    mode: z.enum(['existing', 'walk_in']),
    userId: z.string().trim().min(1).max(64).optional().nullable(),
    posCustomerId: z.string().trim().min(1).max(64).optional().nullable(),
    name: z.string().trim().min(2).max(120).optional(),
    phone: z
      .string()
      .trim()
      .max(24)
      .regex(/^[\d\s+()-]*$/, 'Solo dígitos y símbolos de teléfono')
      .optional(),
    email: z.union([z.string().trim().email().max(120), z.literal('')]).optional().nullable(),
  })
  .superRefine((customer, ctx) => {
    if (customer.mode === 'existing' && !customer.userId && !customer.posCustomerId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['userId'],
        message: 'Selecciona un cliente existente',
      })
    }
  })

export const posSaleSchema = z.object({
  customer: posCustomerSchema,
  items: z
    .array(
      z.object({
        sku: z.string().trim().min(1).max(120),
        quantity: z.number().int().positive().max(999),
      }),
    )
    .min(1, 'La venta necesita al menos un producto')
    .max(100),
  payment: z.object({
    method: z.string().trim().min(1).max(40),
    state: z.enum(['pending_manual', 'paid']),
    cashReceived: z.number().min(0).max(9_999_999).optional(),
    changeGiven: z.number().min(0).max(9_999_999).optional(),
    transferReference: z.string().trim().max(120).optional(),
  }),
  discountAmount: z.number().min(0).max(9_999_999).optional(),
  notes: z.string().trim().max(500).optional(),
})

export type PosSaleDto = z.infer<typeof posSaleSchema>

export const posSearchQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(30).optional(),
})

export const posConfirmPaymentSchema = z.object({
  cashReceived: z.number().min(0).max(9_999_999).optional(),
  changeGiven: z.number().min(0).max(9_999_999).optional(),
  transferReference: z.string().trim().max(120).optional(),
  note: z.string().trim().max(500).optional(),
})

export const posBarcodeSchema = z.object({
  barcode: z
    .string()
    .trim()
    .min(4)
    .max(64)
    .regex(/^[A-Za-z0-9._-]+$/, 'Código inválido'),
})

export const posProductSearchQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().refine((n) => [10, 20, 50].includes(n), 'Tamaño de página no válido').default(10),
})

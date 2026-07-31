import { z } from 'zod'
import { isStoreBannerPosition, type StoreBannerPosition } from '../../catalog/domain/store-banner.entity.js'

export const adminProductCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  slug: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: z.string().max(8000).optional(),
  category_slug: z.string().max(120).optional(),
  brand: z.string().max(120).optional(),
  status: z.enum(['active', 'inactive']).optional(),
  image_path: z.string().max(500).optional(),
})

export const adminProductPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    slug: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .optional(),
    description: z.string().max(8000).optional().nullable(),
    category_slug: z.string().max(120).optional().nullable(),
    brand: z.string().max(120).optional().nullable(),
    status: z.enum(['active', 'inactive']).optional(),
    image_path: z.string().max(500).optional().nullable(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'Vacío' })

export const adminCategorySchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
})

export const adminOrderPatchSchema = z
  .object({
    status: z.enum(['pending', 'paid', 'shipped', 'delivered', 'cancelled', 'expired']).optional(),
    paymentStatus: z
      .enum([
        'unpaid',
        'pending',
        'in_process',
        'pending_manual',
        'paid',
        'refunded',
        'failed',
        'expired',
        'deposit_pending',
        'deposit_paid',
        'final_payment_pending',
        'payment_completed',
      ])
      .optional(),
    notes: z.string().max(2000).optional(),
    cancellationReason: z.string().max(1000).optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'Vacío' })

export const adminCancellationResolveSchema = z.object({
  resolution: z.enum(['approved', 'rejected', 'info_needed']),
  adminNote: z.string().max(1000).optional(),
  customerResponse: z.string().max(1000).optional(),
})

const productEntrySchema = z.object({
  product_slug: z.string().min(1).max(200),
  percent_off: z.union([z.number().min(0).max(100), z.null()]),
})

export const promotionUpsertSchema = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(8000).optional().nullable(),
    banner_url: z.union([z.string().max(2000), z.literal('')]).optional().nullable(),
    active: z.boolean().optional(),
    starts_at: z.string(),
    ends_at: z.string(),
    priority: z.number().int().min(0).max(999999).optional(),
    apply_general_discount: z.boolean(),
    general_percent_off: z.number().min(0).max(100).optional().nullable(),
    category_slugs: z.array(z.string().min(1).max(200)).optional(),
    product_entries: z.array(productEntrySchema).optional(),
    notification_image_slug: z.union([z.string().max(200), z.literal('')]).optional().nullable(),
    notification_image_path: z.union([z.string().max(2000), z.literal('')]).optional().nullable(),
  })
  .superRefine((data, ctx) => {
    const starts = new Date(data.starts_at)
    const ends = new Date(data.ends_at)
    if (Number.isNaN(starts.getTime())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'fecha inicio inválida', path: ['starts_at'] })
    }
    if (Number.isNaN(ends.getTime())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'fecha fin inválida', path: ['ends_at'] })
    }
    if (!Number.isNaN(starts.getTime()) && !Number.isNaN(ends.getTime()) && ends <= starts) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'La fecha de fin debe ser posterior al inicio',
        path: ['ends_at'],
      })
    }
  })

export type PromotionUpsertInput = z.infer<typeof promotionUpsertSchema>

export const storeBannerUpsertSchema = z
  .object({
    active: z.boolean().optional(),
    position: z.string().refine((v): v is StoreBannerPosition => isStoreBannerPosition(v), {
      message: 'posición inválida',
    }),
    priority: z.number().int().min(0).max(999999).optional(),
    starts_at: z.string(),
    ends_at: z.string(),
    image_url: z.string().min(1).max(4000),
    title: z.string().max(300).optional().nullable(),
    subtitle: z.string().max(800).optional().nullable(),
    cta_label: z.string().max(120).optional().nullable(),
    cta_href: z.string().max(2000).optional().nullable(),
    promotion_id: z.string().max(64).optional().nullable(),
    category_slug: z.string().max(200).optional().nullable(),
    collection_slug: z.string().max(200).optional().nullable(),
  })
  .superRefine((data, ctx) => {
    const s = new Date(data.starts_at)
    const e = new Date(data.ends_at)
    if (Number.isNaN(s.getTime())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'fecha inicio inválida', path: ['starts_at'] })
    }
    if (Number.isNaN(e.getTime())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'fecha fin inválida', path: ['ends_at'] })
    }
    if (!Number.isNaN(s.getTime()) && !Number.isNaN(e.getTime()) && e <= s) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'La fecha de fin debe ser posterior al inicio',
        path: ['ends_at'],
      })
    }
  })

export type StoreBannerUpsertInput = z.infer<typeof storeBannerUpsertSchema>

export const adminVariantCreateSchema = z.object({
  sku: z.string().min(1).max(80).regex(/^[A-Za-z0-9._\-]+$/),
  price: z.number().positive(),
  currency: z.string().min(1).max(8),
  options: z.record(z.string()).optional(),
  compare_at_price: z.number().positive().optional(),
  image_path: z.string().max(500).optional(),
})

export const adminVariantPatchSchema = z
  .object({
    price: z.number().positive().optional(),
    currency: z.string().min(1).max(8).optional(),
    options: z.record(z.string()).optional(),
    compare_at_price: z.number().positive().optional().nullable(),
    image_path: z.string().max(500).optional().nullable(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'Vacío' })

export const adminInventoryUpsertSchema = z.object({
  quantity: z.number().int().min(0),
  reserved: z.number().int().min(0).optional(),
  warehouse: z.string().max(100).optional(),
  is_per_order: z.boolean().optional(),
})

export const adminStaffRoleSchema = z.object({
  role: z.enum(['admin', 'moderator', 'user']),
})

export const adminPromotionActiveSchema = z.object({
  active: z.boolean(),
})

export const adminDepositConfigureSchema = z.object({
  percentage: z.number().min(1).max(99),
})

export const adminPaymentAmountSchema = z.object({
  amount: z.number().min(0),
  note: z.string().max(500).optional(),
})

export const adminProductOptionsSchema = z.object({
  axes: z
    .array(
      z.object({
        name: z.string().min(1).max(120),
        position: z.number().int().min(0).optional(),
        values: z
          .array(
            z.object({
              value: z.string().min(1).max(200),
              position: z.number().int().min(0).optional(),
            }),
          )
          .min(1),
      }),
    )
    .max(3),
})

export const adminPaymentMethodsSchema = z.object({
  methods: z
    .array(
      z.object({
        methodId: z.enum(['mercadopago', 'manual']),
        isActive: z.boolean(),
      }),
    )
    .min(1)
    .max(10),
})

export const adminRevokeSessionSchema = z.object({
  sessionId: z.string().min(1),
})

export const adminFeedbackReviewPatchSchema = z.object({
  hidden: z.boolean().optional(),
  featured: z.boolean().optional(),
})

export const adminFeedbackQuestionPatchSchema = z.object({
  hidden: z.boolean().optional(),
  answered: z.boolean().optional(),
})

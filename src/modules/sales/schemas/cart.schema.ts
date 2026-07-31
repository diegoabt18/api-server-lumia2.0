import { z } from 'zod'

export const addCartItemSchema = z.object({
  sku: z.string().trim().min(1),
  quantity: z.number().int().positive().default(1),
  product: z
    .object({
      productSlug: z.string().trim().min(1),
      productName: z.string().trim().min(1),
      variantLabel: z.string().trim().optional(),
      currency: z.string().default('COP'),
      imagePath: z.string().nullable().optional(),
    })
    .optional(),
})

export const updateCartItemSchema = z.object({
  sku: z.string().trim().min(1),
  quantity: z.number().int().min(0),
})

export const removeCartItemSchema = z.object({
  sku: z.string().trim().min(1),
})

export type AddCartItemDto = z.infer<typeof addCartItemSchema>

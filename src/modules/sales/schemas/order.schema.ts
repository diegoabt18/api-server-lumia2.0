import { z } from 'zod'

export const createOrderItemSchema = z.object({
  productId: z.string().min(1),
  productSlug: z.string().optional(),
  variantSku: z.string().optional(),
  variantName: z.string().optional(),
  name: z.string().min(1),
  quantity: z.number().int().positive(),
  unitPrice: z.number().nonnegative(),
  subtotal: z.number().nonnegative(),
  selectionLabel: z.string().optional(),
  selectedOptions: z
    .array(z.object({ label: z.string(), value: z.string() }))
    .optional(),
  imageUrl: z.string().optional(),
})

export const createOrderSchema = z.object({
  customerName: z.string().min(2),
  phone: z.string().min(7),
  whatsapp: z.string().optional(),
  email: z.string().email().optional().nullable(),
  address: z.string().min(5),
  city: z.string().min(2),
  reference: z.string().default(''),
  notes: z.string().optional(),
  items: z.array(createOrderItemSchema).min(1),
  subtotal: z.number().nonnegative().optional(),
  shippingCost: z.number().nonnegative().optional(),
  tax: z.number().nonnegative().optional(),
  discountAmount: z.number().nonnegative().optional(),
  total: z.number().positive(),
  currency: z.string().default('COP'),
  paymentMethod: z.string().optional(),
})

export type CreateOrderDto = z.infer<typeof createOrderSchema>

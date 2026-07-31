import { z } from 'zod'

/** Checkout lumia2.0 — solo datos de envío; items vienen del carrito. */
export const checkoutShippingSchema = z.object({
  customerName: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(120).optional(),
  phone: z.string().trim().min(8).max(24),
  address: z.string().trim().min(5).max(200),
  city: z.string().trim().min(2).max(80),
  reference: z.string().trim().min(1).max(200),
  notes: z.string().trim().max(500).optional(),
  turnstileToken: z.string().trim().min(1).optional(),
})

export type CheckoutShippingDto = z.infer<typeof checkoutShippingSchema>

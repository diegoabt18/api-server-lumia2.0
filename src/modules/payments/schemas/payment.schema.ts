import { z } from 'zod'

export const manualPaymentSchema = z.object({
  orderId: z.string().trim().min(1),
})

export const cancelOrderSchema = z.object({
  reason: z.string().trim().max(1000).optional(),
})

export const cancelRequestSchema = z.object({
  reason: z.string().trim().min(1, 'Debes indicar un motivo').max(1000),
})

export type ManualPaymentDto = z.infer<typeof manualPaymentSchema>
export type CancelOrderDto = z.infer<typeof cancelOrderSchema>
export type CancelRequestDto = z.infer<typeof cancelRequestSchema>

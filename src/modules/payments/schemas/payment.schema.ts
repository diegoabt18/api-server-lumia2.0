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

/** Registro de un pago en mostrador (G3). El importe se valida contra el saldo en el servicio. */
export const orderPaymentRegisterSchema = z.object({
  method: z.enum(['cash', 'bank_transfer']),
  amount: z.number().finite().positive(),
  receivedAmount: z.number().finite().nonnegative().nullable().optional(),
  transferReference: z.string().trim().min(1).max(120).nullable().optional(),
  note: z.string().trim().max(500).optional(),
  idempotencyKey: z.string().trim().min(1).max(100).optional(),
})

export type ManualPaymentDto = z.infer<typeof manualPaymentSchema>
export type CancelOrderDto = z.infer<typeof cancelOrderSchema>
export type CancelRequestDto = z.infer<typeof cancelRequestSchema>

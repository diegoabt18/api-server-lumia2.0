import { z } from 'zod'
import { lumiContextInputSchema } from '../services/lumi-context.js'

export const lumiChatBodySchema = z.object({
  message: z.string().trim().min(1).max(4000),
  conversationId: z.string().uuid().optional(),
  context: lumiContextInputSchema.optional(),
})

export const lumiListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
})

export const lumiUsageQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
})

export const lumiProductParamsSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{24}$/i),
})

export const lumiConversationParamsSchema = z.object({
  id: z.string().uuid(),
})

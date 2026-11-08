import { z } from 'zod'

/** Reglas alineadas con el contrato que ya usa Lumia (api-embedded) para no romper clientes. */
export const reviewWriteSchema = z.object({
  stars: z.number().min(1).max(5),
  title: z.string().max(200).optional(),
  body: z.string().max(4000).optional(),
  images: z.array(z.string().max(1000)).max(5).optional(),
})

export const reactionSchema = z.object({
  reaction: z.enum(['helpful', 'not_helpful']),
})

export const questionWriteSchema = z.object({
  body: z.string().min(5).max(2000),
})

export const answerWriteSchema = z.object({
  body: z.string().min(2).max(2500),
})

export const reportWriteSchema = z.object({
  entityType: z.enum(['review', 'question', 'answer']),
  entityId: z.string().min(1).max(64),
  reason: z.string().min(3).max(400),
})

export const feedbackQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  reviewPage: z.coerce.number().int().min(1).max(10_000).optional(),
  reviewLimit: z.coerce.number().int().min(1).max(50).optional(),
  questionPage: z.coerce.number().int().min(1).max(10_000).optional(),
  questionLimit: z.coerce.number().int().min(1).max(50).optional(),
  stars: z.coerce.number().int().min(1).max(5).optional(),
  verifiedOnly: z.enum(['0', '1', 'true', 'false']).optional(),
  reviewSort: z.enum(['recent', 'useful']).optional(),
})

/** Quita etiquetas HTML y espacios sobrantes antes de guardar texto libre. */
export function sanitizeFeedbackText(input: unknown, max = 2000): string {
  return String(input ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

import { z } from 'zod'
import { lumiContextInputSchema } from '../services/lumi-context.js'

export const lumiChatBodySchema = z.object({
  message: z.string().trim().min(1).max(4000),
  conversationId: z.string().uuid().optional(),
  /** Id del mensaje en el cliente: un reintento con el mismo id no repite el turno ni lo duplica. */
  clientMessageId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,64}$/)
    .optional(),
  context: lumiContextInputSchema.optional(),
  /** Búsqueda web (requiere lumi.web). Campo previo; `webMode` lo sustituye. */
  webSearch: z.boolean().optional(),
  /** Razonamiento del modelo. Campo previo; `reasoningMode` lo sustituye. */
  think: z.boolean().optional(),
  /** Controles del chat: automático (lo decide el servidor), activado o desactivado. */
  reasoningMode: z.enum(['auto', 'on', 'off']).optional(),
  webMode: z.enum(['auto', 'on', 'off']).optional(),
  /** Límite de tokens de la respuesta. Si se omite, lo decide ia-asistente. */
  maxTokens: z.number().int().min(128).max(2048).optional(),
  /** Respuesta con botón a una confirmación del equipo: solo actúa sobre esa acción pendiente. */
  confirmationId: z
    .string()
    .regex(/^[a-f0-9]{24}$/)
    .optional(),
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

export const lumiMusicSelectionParamsSchema = z.object({
  queryId: z.string().uuid(),
})

export const lumiMusicSelectionBodySchema = z.object({
  candidateId: z.string().regex(/^[0-9a-f]{16}$/),
  /** Conversación de la tarjeta: debe ser la misma en la que se mostró la búsqueda. */
  conversationId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).optional(),
  /** Mensaje del chat que muestra la tarjeta (id del cliente): se devuelve en cada evento. */
  messageId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_:-]+$/).optional(),
})

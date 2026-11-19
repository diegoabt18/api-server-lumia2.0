import { z } from 'zod'
import { lumiContextInputSchema } from '../services/lumi-context.js'

export const lumiChatBodySchema = z.object({
  message: z.string().trim().min(1).max(4000),
  conversationId: z.string().uuid().optional(),
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
})

/**
 * Órdenes del reproductor del chat (botones de Lumia Admin). Lista cerrada con argumentos tipados:
 * nada de búsquedas ni comandos libres desde el navegador. El permiso de cada una lo comprueba la ruta.
 */
const noArgs = z.object({}).strict().default({})
export const lumiMusicPlayerCommandSchema = z.discriminatedUnion('tool', [
  z.object({ tool: z.literal('music.play'), args: noArgs }).strict(),
  z.object({ tool: z.literal('music.pause'), args: noArgs }).strict(),
  z.object({ tool: z.literal('music.resume'), args: noArgs }).strict(),
  z.object({ tool: z.literal('music.stop'), args: noArgs }).strict(),
  z.object({ tool: z.literal('music.next'), args: noArgs }).strict(),
  z.object({ tool: z.literal('music.previous'), args: noArgs }).strict(),
  z.object({ tool: z.literal('music.volume'), args: z.object({ level: z.number().int().min(0).max(100) }).strict() }).strict(),
  z.object({ tool: z.literal('music.seek'), args: z.object({ position: z.number().int().min(0).max(24 * 3600) }).strict() }).strict(),
  z.object({ tool: z.literal('music.jump'), args: z.object({ position: z.number().int().min(1).max(50) }).strict() }).strict(),
])
export type LumiMusicPlayerCommand = z.infer<typeof lumiMusicPlayerCommandSchema>

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

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
const musicVideoId = z.string().regex(/^[A-Za-z0-9_-]{11}$/)
const queuePosition = z.number().int().min(1).max(50)
const onOff = z.enum(['on', 'off'])
export const lumiMusicPlayerCommandSchema = z.discriminatedUnion('tool', [
  // Sin argumentos reanuda o empieza la cola; con video_id (de un resultado mostrado) pone esa canción.
  z.object({ tool: z.literal('music.play'), args: z.object({ video_id: musicVideoId.optional() }).strict().default({}) }).strict(),
  z.object({ tool: z.literal('music.enqueue'), args: z.object({ video_id: musicVideoId }).strict() }).strict(),
  z.object({ tool: z.literal('music.play_next'), args: z.object({ video_id: musicVideoId }).strict() }).strict(),
  z.object({ tool: z.literal('music.remove'), args: z.object({ position: queuePosition }).strict() }).strict(),
  z.object({ tool: z.literal('music.move'), args: z.object({ position: queuePosition, to: queuePosition }).strict() }).strict(),
  z.object({ tool: z.literal('music.clear_queue'), args: noArgs }).strict(),
  z.object({ tool: z.literal('music.shuffle'), args: z.object({ state: onOff }).strict() }).strict(),
  z.object({ tool: z.literal('music.repeat'), args: z.object({ repeat: z.enum(['off', 'one', 'all']) }).strict() }).strict(),
  z.object({ tool: z.literal('music.autoplay'), args: z.object({ state: onOff }).strict() }).strict(),
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

export const lumiMusicRecommendationsQuerySchema = z.object({ videoId: musicVideoId.optional() }).strict()
export const lumiMusicSearchQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(200),
    limit: z.coerce.number().int().min(1).max(10).default(8),
  })
  .strict()

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

import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../app.context.js'
import { requireAuth, type AuthenticatedRequest } from '../modules/identity/middleware/auth.middleware.js'

const HEARTBEAT_MS = 25_000
/** Conexiones abiertas por usuario (pestañas). Al superarlo se cierra la más antigua. */
export const MAX_STREAMS_PER_USER = 5
/** Duración máxima de un stream cuando no se conoce la caducidad del token. */
const MAX_STREAM_MS = 15 * 60_000

/**
 * Canal SSE de notificaciones del usuario autenticado. Las notificaciones nuevas llegan en tiempo
 * real mientras haya una pestaña abierta; al reconectar, el cliente recupera el historial con
 * GET /api/notifications.
 *
 * El stream se cierra cuando caduca el token de acceso con el que se abrió: así una sesión
 * revocada o con permisos cambiados no sigue recibiendo avisos indefinidamente. EventSource
 * reconecta solo y la reconexión vuelve a pasar por la autenticación (y por la renovación del BFF).
 */
export async function registerNotificationStreamRoutes(api: FastifyInstance, ctx: AppContext) {
  const authGuard = requireAuth(ctx.repos.sessions, ctx.services.authorization)
  const openStreams = new Map<string, Set<() => void>>()

  api.get('/notifications/stream', { preHandler: authGuard }, async (request, reply) => {
    const userId = (request as AuthenticatedRequest).auth.userId
    const token =
      request.headers.authorization?.replace(/^Bearer\s+/i, '') ||
      request.cookies[ctx.env.COOKIE_ACCESS_NAME]
    const expiresAt = token ? ctx.jwt.getAccessExpiresAtMs(token) : null
    const lifetimeMs = Math.max(
      1_000,
      Math.min(MAX_STREAM_MS, expiresAt ? expiresAt - Date.now() : MAX_STREAM_MS),
    )

    reply.hijack()
    const raw = reply.raw
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    raw.write('event: ready\ndata: {}\n\n')

    const unsubscribe = ctx.services.notificationHub.subscribe(userId, (event, data) => {
      raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    })
    const heartbeat = setInterval(() => raw.write(': ping\n\n'), HEARTBEAT_MS)
    const close = () => raw.end()
    const expiry = setTimeout(close, lifetimeMs)

    const streams = openStreams.get(userId) ?? new Set<() => void>()
    openStreams.set(userId, streams)
    streams.add(close)
    if (streams.size > MAX_STREAMS_PER_USER) {
      // El Set conserva el orden de inserción: el primero es la conexión más antigua.
      const oldest = streams.values().next().value
      if (oldest) {
        streams.delete(oldest)
        oldest()
      }
    }

    raw.once('close', () => {
      clearInterval(heartbeat)
      clearTimeout(expiry)
      unsubscribe()
      streams.delete(close)
      if (streams.size === 0 && openStreams.get(userId) === streams) openStreams.delete(userId)
    })
  })
}

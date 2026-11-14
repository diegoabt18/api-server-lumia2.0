import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../app.context.js'
import { requireAuth, type AuthenticatedRequest } from '../modules/identity/middleware/auth.middleware.js'

const HEARTBEAT_MS = 25_000

/**
 * Canal SSE de notificaciones del usuario autenticado. Las notificaciones nuevas llegan en tiempo
 * real mientras haya una pestaña abierta; al reconectar, el cliente recupera el historial con
 * GET /api/notifications.
 */
export async function registerNotificationStreamRoutes(api: FastifyInstance, ctx: AppContext) {
  const authGuard = requireAuth(ctx.repos.sessions, ctx.services.authorization)

  api.get('/notifications/stream', { preHandler: authGuard }, async (request, reply) => {
    const userId = (request as AuthenticatedRequest).auth.userId
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
    raw.once('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
    })
  })
}

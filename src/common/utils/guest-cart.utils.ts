import { randomUUID } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'

export const GUEST_CART_COOKIE = 'lumia_guest_cart'

export function getGuestCartKey(request: FastifyRequest): string | undefined {
  return request.cookies[GUEST_CART_COOKIE]?.trim() || undefined
}

export function ensureGuestCartKey(request: FastifyRequest, reply: FastifyReply): string {
  const existing = getGuestCartKey(request)
  if (existing) return existing

  const key = `guest_${randomUUID()}`
  const env = request.server.config.env
  const secure = env.NODE_ENV === 'production'
  reply.setCookie(GUEST_CART_COOKIE, key, {
    httpOnly: true,
    secure,
    sameSite: secure ? 'none' : 'lax',
    domain: env.COOKIE_DOMAIN || undefined,
    path: '/',
    maxAge: 30 * 24 * 60 * 60,
  })
  return key
}

export function clearGuestCartCookie(reply: FastifyReply, request: FastifyRequest) {
  const env = request.server.config.env
  reply.clearCookie(GUEST_CART_COOKIE, {
    path: '/',
    domain: env.COOKIE_DOMAIN || undefined,
  })
}

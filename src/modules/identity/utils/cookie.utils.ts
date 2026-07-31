import type { FastifyReply, FastifyRequest } from 'fastify'
import { getEnv, isCookieSecure } from '../../../config/env.js'

export function setAuthCookies(
  reply: FastifyReply,
  _request: FastifyRequest,
  tokens: { accessToken: string; refreshToken: string; refreshMaxAgeSeconds: number },
) {
  const env = getEnv()
  const secure = isCookieSecure(env)
  const domain = env.COOKIE_DOMAIN || undefined
  const sameSite = secure ? ('none' as const) : ('lax' as const)

  reply.setCookie(env.COOKIE_ACCESS_NAME, tokens.accessToken, {
    httpOnly: true,
    secure,
    sameSite,
    domain,
    path: '/',
    maxAge: 10 * 60,
  })

  reply.setCookie(env.COOKIE_REFRESH_NAME, tokens.refreshToken, {
    httpOnly: true,
    secure,
    sameSite,
    domain,
    path: '/',
    maxAge: tokens.refreshMaxAgeSeconds,
  })
}

export function clearAuthCookies(reply: FastifyReply, _request: FastifyRequest) {
  const env = getEnv()
  const domain = env.COOKIE_DOMAIN || undefined

  reply.clearCookie(env.COOKIE_ACCESS_NAME, { path: '/', domain })
  reply.clearCookie(env.COOKIE_REFRESH_NAME, { path: '/', domain })
}

export function getRefreshTokenFromRequest(request: FastifyRequest): string | undefined {
  const env = getEnv()
  return request.cookies[env.COOKIE_REFRESH_NAME]
}

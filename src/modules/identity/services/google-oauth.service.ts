import { createHash, randomBytes } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { getEnv, isCookieSecure } from '../../../config/env.js'
import { AppError } from '../../../common/errors/app.error.js'
import type { AuthService } from '../services/auth.service.js'
import type { UserRepository } from '../infrastructure/user.repository.js'
import type { CartRepository } from '../../sales/infrastructure/cart.repository.js'
import {
  clearGuestCartCookie,
  getGuestCartKey,
} from '../../../common/utils/guest-cart.utils.js'

const OAUTH_COOKIE_PATH = '/api/auth/google'
const OAUTH_MAX_AGE = 600

function oauthCookieOpts(_request: FastifyRequest) {
  const env = getEnv()
  const secure = isCookieSecure(env)
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure,
    path: OAUTH_COOKIE_PATH,
    maxAge: OAUTH_MAX_AGE,
    domain: env.COOKIE_DOMAIN || undefined,
  }
}

function safeReturnPath(raw: unknown): string {
  if (typeof raw !== 'string') return '/'
  const path = raw.trim()
  if (!path.startsWith('/') || path.startsWith('//')) return '/'
  return path
}

export class GoogleOAuthService {
  constructor(
    private readonly users: UserRepository,
    private readonly auth: AuthService,
    private readonly carts: CartRepository,
  ) {}

  startLogin(request: FastifyRequest, reply: FastifyReply) {
    const env = getEnv()
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      throw AppError.internal('Google OAuth no configurado')
    }

    const query = request.query as Record<string, string | undefined>
    const state = randomBytes(16).toString('hex')
    const returnPath = safeReturnPath(query.return)
    const opts = oauthCookieOpts(request)

    reply.setCookie('oauth_state', state, opts)
    reply.setCookie('oauth_return', returnPath, opts)

    const redirectUri = `${env.FRONTEND_URL.replace(/\/$/, '')}/api/auth/google/callback`
    const params = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      access_type: 'online',
      prompt: 'select_account',
    })

    return reply.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`)
  }

  async handleCallback(request: FastifyRequest, reply: FastifyReply) {
    const env = getEnv()
    const query = request.query as Record<string, string | undefined>
    const code = query.code
    const state = query.state
    const oauthError = query.error

    const loginError = (code: string) =>
      reply.redirect(`${env.FRONTEND_URL}/auth/login?error=${code}`)

    if (oauthError) return loginError('LG_ERROR001')

    const savedState = request.cookies.oauth_state
    const returnPath = safeReturnPath(request.cookies.oauth_return)
    const opts = oauthCookieOpts(request)
    reply.clearCookie('oauth_state', opts)
    reply.clearCookie('oauth_return', opts)

    if (!code || !state || !savedState || state !== savedState) {
      return loginError('LG_ERROR002')
    }

    const redirectUri = `${env.FRONTEND_URL.replace(/\/$/, '')}/api/auth/google/callback`
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID!,
        client_secret: env.GOOGLE_CLIENT_SECRET!,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    })

    if (!tokenRes.ok) return loginError('LG_ERROR003')
    const tokens = (await tokenRes.json()) as { id_token?: string }
    if (!tokens.id_token) return loginError('LG_ERROR004')

    const payload = this.parseIdToken(tokens.id_token)
    if (!payload.sub || !payload.email) return loginError('LG_ERROR005')

    const user = await this.users.upsertGoogleUser({
      googleId: payload.sub,
      email: payload.email,
      nickname: payload.name ?? payload.email.split('@')[0] ?? 'Usuario',
    })

    const guestKey = getGuestCartKey(request)
    if (guestKey && user._id) {
      await this.carts.mergeGuestIntoUser(guestKey, user._id)
      clearGuestCartCookie(reply, request)
    }

    const session = await this.auth.issueTokensForGoogleUser(user, {
      userAgent: request.headers['user-agent'],
      ip: request.ip,
      acceptLanguage: request.headers['accept-language'] as string | undefined,
    })

    const { setAuthCookies } = await import('../utils/cookie.utils.js')
    setAuthCookies(reply, request, {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      refreshMaxAgeSeconds: session.refreshMaxAgeSeconds,
    })

    return reply.redirect(`${env.FRONTEND_URL}${returnPath}`)
  }

  private parseIdToken(idToken: string): { sub?: string; email?: string; name?: string } {
    const parts = idToken.split('.')
    if (parts.length < 2) return {}
    try {
      return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    } catch {
      return {}
    }
  }
}

/** Hash helper for optional nonce validation */
export function hashOAuthValue(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

import jwt from 'jsonwebtoken'
import { getEnv } from '../../../config/env.js'
import type { AccessTokenPayload } from '../domain/session.entity.js'

export class JwtTokenService {
  signAccess(payload: Omit<AccessTokenPayload, 'issuedAtMs'>): string {
    const env = getEnv()
    return jwt.sign(payload, env.JWT_SECRET, {
      expiresIn: env.JWT_ACCESS_EXPIRES_IN as jwt.SignOptions['expiresIn'],
    })
  }

  verifyAccess(token: string): AccessTokenPayload | null {
    try {
      const env = getEnv()
      const decoded = jwt.verify(token, env.JWT_SECRET) as AccessTokenPayload & {
        iat?: number
      }
      if (
        typeof decoded.userId !== 'string' ||
        typeof decoded.sessionId !== 'string' ||
        typeof decoded.permHash !== 'string'
      ) {
        return null
      }
      const permissionsVersion =
        typeof decoded.permissionsVersion === 'number' ? decoded.permissionsVersion : 1
      const issuedAtMs = typeof decoded.iat === 'number' ? decoded.iat * 1000 : undefined
      return {
        userId: decoded.userId,
        sessionId: decoded.sessionId,
        permHash: decoded.permHash,
        permissionsVersion,
        issuedAtMs,
      }
    } catch {
      return null
    }
  }

  getAccessExpiresAtMs(token: string): number | null {
    try {
      const env = getEnv()
      const decoded = jwt.verify(token, env.JWT_SECRET) as { exp?: number }
      return decoded.exp ? decoded.exp * 1000 : null
    } catch {
      return null
    }
  }

  buildAccessPayload(params: {
    userId: string
    sessionId: string
    permHash: string
    permissionsVersion: number
  }): Omit<AccessTokenPayload, 'issuedAtMs'> {
    return {
      userId: params.userId,
      sessionId: params.sessionId,
      permHash: params.permHash,
      permissionsVersion: params.permissionsVersion,
    }
  }
}

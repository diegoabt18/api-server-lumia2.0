import jwt from 'jsonwebtoken'
import { getEnv } from '../../../config/env.js'
import type { AccessTokenPayload } from '../domain/session.entity.js'
import type { UserRole } from '../../../common/permissions/registry.js'

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
        typeof decoded.role !== 'string' ||
        typeof decoded.permHash !== 'string'
      ) {
        return null
      }
      const permissionsVersion =
        typeof decoded.permissionsVersion === 'number' ? decoded.permissionsVersion : 1
      const issuedAtMs =
        typeof decoded.iat === 'number' ? decoded.iat * 1000 : undefined
      return {
        userId: decoded.userId,
        role: decoded.role,
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
    role: UserRole
    sessionId: string
    permHash: string
    permissionsVersion: number
  }): Omit<AccessTokenPayload, 'issuedAtMs'> {
    return {
      userId: params.userId,
      role: params.role,
      sessionId: params.sessionId,
      permHash: params.permHash,
      permissionsVersion: params.permissionsVersion,
    }
  }
}

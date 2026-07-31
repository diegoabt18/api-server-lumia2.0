import jwt from 'jsonwebtoken'
import { getEnv } from '../../../config/env.js'

export const TWO_FA_TEMP_TOKEN_TTL = '5m'

export interface TwoFactorTempPayload {
  userId: string
  rememberMe?: boolean
  userAgent?: string
  ip?: string
  country?: string | null
  acceptLanguage?: string
  purpose: '2fa_login'
}

export function signTwoFactorTempToken(
  payload: Omit<TwoFactorTempPayload, 'purpose'>,
): string {
  const env = getEnv()
  return jwt.sign({ ...payload, purpose: '2fa_login' }, env.JWT_SECRET, {
    expiresIn: TWO_FA_TEMP_TOKEN_TTL,
  })
}

export function verifyTwoFactorTempToken(token: string): TwoFactorTempPayload | null {
  try {
    const env = getEnv()
    const decoded = jwt.verify(token, env.JWT_SECRET) as Partial<TwoFactorTempPayload>
    if (decoded.purpose !== '2fa_login' || typeof decoded.userId !== 'string') return null
    return decoded as TwoFactorTempPayload
  } catch {
    return null
  }
}

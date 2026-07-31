import jwt from 'jsonwebtoken'
import { getEnv } from '../../../config/env.js'
import { AppError } from '../../../common/errors/app.error.js'

const PURPOSE = 'order_view'

export function signOrderAccessToken(orderId: string): string {
  const env = getEnv()
  return jwt.sign({ orderId, purpose: PURPOSE }, env.JWT_SECRET, { expiresIn: '7d' })
}

export function verifyOrderAccessToken(token: string): string {
  const env = getEnv()
  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as { orderId?: string; purpose?: string }
    if (payload.purpose !== PURPOSE || !payload.orderId) {
      throw AppError.unauthorized('Invalid order token')
    }
    return payload.orderId
  } catch {
    throw AppError.unauthorized('Invalid order token')
  }
}

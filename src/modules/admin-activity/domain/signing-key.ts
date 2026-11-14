import { hkdfSync } from 'node:crypto'
import type { Env } from '../../../config/env.js'

/**
 * Clave HMAC de la cadena de auditoría. Preferible una clave propia (ADMIN_AUDIT_SIGNING_KEY);
 * si no existe se deriva de JWT_SECRET con HKDF, separada del uso de firma de tokens.
 */
export function activityAuditKey(env: Pick<Env, 'ADMIN_AUDIT_SIGNING_KEY' | 'JWT_SECRET'>): string {
  if (env.ADMIN_AUDIT_SIGNING_KEY) return env.ADMIN_AUDIT_SIGNING_KEY
  return Buffer.from(
    hkdfSync('sha256', env.JWT_SECRET, 'lumia-admin-activity-audit', 'hmac-chain-v1', 32),
  ).toString('hex')
}

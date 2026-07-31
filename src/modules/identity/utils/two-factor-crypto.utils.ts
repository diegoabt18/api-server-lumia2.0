import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { getEnv } from '../../../config/env.js'

const ALGO = 'aes-256-gcm'

function getEncryptionKey(): Buffer {
  const env = getEnv()
  const raw = env.TWO_FACTOR_ENCRYPTION_KEY?.trim() || env.JWT_SECRET
  return scryptSync(raw, 'lumia-2fa-v1', 32)
}

export function encryptTwoFactorSecret(plain: string): string {
  const key = getEncryptionKey()
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGO, key, iv)
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, encrypted]).toString('base64')
}

export function decryptTwoFactorSecret(encoded: string): string {
  const buf = Buffer.from(encoded, 'base64')
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(12, 28)
  const data = buf.subarray(28)
  const key = getEncryptionKey()
  const decipher = createDecipheriv(ALGO, key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}

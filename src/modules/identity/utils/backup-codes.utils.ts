import { createHash, randomBytes } from 'node:crypto'

const BACKUP_CODE_COUNT = 10

export function hashBackupCode(code: string): string {
  return createHash('sha256').update(code.trim().toUpperCase()).digest('hex')
}

export function generateBackupCodes(count = BACKUP_CODE_COUNT): string[] {
  const codes: string[] = []
  for (let i = 0; i < count; i++) {
    codes.push(randomBytes(6).toString('hex').toUpperCase().slice(0, 8))
  }
  return codes
}

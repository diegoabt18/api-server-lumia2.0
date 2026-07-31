import { randomUUID } from 'node:crypto'

export const NICKNAME_REGEX = /^[a-zA-Z0-9_]+$/
export const NICKNAME_MIN = 3
export const NICKNAME_MAX = 24

const WORDS = ['paloma', 'gato', 'luna', 'tigre', 'nube', 'zorro', 'panda', 'estrella', 'rio', 'bosque']

export function sanitizeNickname(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '').slice(0, NICKNAME_MAX)
}

export function isNicknameValid(nickname: string): boolean {
  return nickname.length >= NICKNAME_MIN && nickname.length <= NICKNAME_MAX && NICKNAME_REGEX.test(nickname)
}

export function generateRandomNickname(): string {
  const randomWord = WORDS[Math.floor(Math.random() * WORDS.length)] ?? 'luna'
  const shortId = randomUUID().split('-')[0]
  return `user_${randomWord}_${shortId}`.slice(0, NICKNAME_MAX)
}

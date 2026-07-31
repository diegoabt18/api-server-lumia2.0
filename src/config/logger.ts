import pino from 'pino'
import type { FastifyBaseLogger } from 'fastify'
import type { Env } from './env.js'

export type AppLogger = FastifyBaseLogger | pino.Logger

/** Logger standalone para scripts CLI (seed, backup). */
export function createScriptLogger(): AppLogger {
  return pino({
    level: 'info',
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:standard' },
    },
  })
}

/** Opciones Pino para Fastify 5 (usa `logger`, no instancia directa). */
export function getFastifyLoggerOptions(env: Env) {
  const isDev = env.NODE_ENV === 'development'

  return {
    level: env.LOG_LEVEL,
    ...(isDev
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:standard' },
          },
        }
      : {}),
    base: { app: env.APP_NAME, env: env.NODE_ENV },
    redact: ['req.headers.authorization', 'req.headers.cookie', 'password', 'passwordHash'],
  }
}

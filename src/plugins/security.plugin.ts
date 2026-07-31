import fp from 'fastify-plugin'
import helmet from '@fastify/helmet'
import cors from '@fastify/cors'
import compress from '@fastify/compress'
import cookie from '@fastify/cookie'
import rateLimit from '@fastify/rate-limit'
import { getCorsOrigins } from '../config/env.js'

export default fp(async (app) => {
  const env = app.ctx.env

  await app.register(helmet, {
    contentSecurityPolicy: env.NODE_ENV === 'production',
  })

  await app.register(cors, {
    origin: getCorsOrigins(env),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
  })

  await app.register(compress)
  await app.register(cookie)

  await app.register(rateLimit, {
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW_MS,
    redis: app.ctx.redis.getClient() ?? undefined,
    skipOnError: true,
    nameSpace: 'lumia-api-rl-',
  })

  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Request-ID', request.id)
  })

  app.addHook('onResponse', async (request, reply) => {
    const responseTime = reply.elapsedTime
    request.log.info(
      {
        reqId: request.id,
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        responseTime,
      },
      'request completed',
    )
  })
})

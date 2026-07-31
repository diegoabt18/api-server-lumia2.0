import Fastify from 'fastify'
import { loadEnv } from './config/env.js'
import { getFastifyLoggerOptions } from './config/logger.js'
import { createAppContext, shutdownAppContext } from './app.context.js'
import contextPlugin, { configPlugin } from './plugins/context.plugin.js'
import securityPlugin from './plugins/security.plugin.js'
import swaggerPlugin from './plugins/swagger.plugin.js'
import { registerErrorHandler, registerHealthRoutes, registerApiRoutes } from './routes/index.js'

export async function buildApp() {
  const env = loadEnv()

  const app = Fastify({
    logger: getFastifyLoggerOptions(env),
    trustProxy: true,
    requestIdHeader: 'x-request-id',
    genReqId: (req) =>
      (req.headers['x-request-id'] as string | undefined) ??
      `req_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
  })

  const ctx = await createAppContext(env, app.log)
  app.decorate('ctx', ctx)
  await app.register(configPlugin)
  await app.register(contextPlugin)
  await app.register(securityPlugin)
  await app.register(swaggerPlugin)

  registerErrorHandler(app)
  await registerHealthRoutes(app)
  await registerApiRoutes(app)

  app.addHook('onClose', async () => {
    await shutdownAppContext(ctx)
  })

  return app
}

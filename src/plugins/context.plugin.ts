import fp from 'fastify-plugin'
import type { AppContext } from '../app.context.js'

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext
  }
}

export default fp(async (app) => {
  // ctx is attached in buildApp before registering plugins
  if (!app.ctx) {
    throw new Error('AppContext must be attached before plugins')
  }
})

declare module 'fastify' {
  interface FastifyInstance {
    config: { env: AppContext['env'] }
  }
}

export const configPlugin = fp(async (app) => {
  app.decorate('config', { env: app.ctx.env })
})

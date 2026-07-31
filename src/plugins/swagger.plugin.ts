import fp from 'fastify-plugin'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'

export default fp(async (app) => {
  const env = app.ctx.env

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Lumia API',
        description: 'eCommerce API — compatible con frontend lumiadalistore.com',
        version: '1.0.0',
      },
      servers: [{ url: env.APP_URL }],
      tags: [
        { name: 'health', description: 'Health checks' },
        { name: 'auth', description: 'Authentication' },
        { name: 'products', description: 'Catalog products' },
        { name: 'categories', description: 'Catalog categories' },
        { name: 'orders', description: 'Sales orders' },
      ],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          cookieAuth: { type: 'apiKey', in: 'cookie', name: 'lumia_access' },
        },
      },
    },
  })

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true },
  })
})

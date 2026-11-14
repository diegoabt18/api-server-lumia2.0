import { buildApp } from './app.js'
import { configureDnsForMongoSrv } from './config/dns.js'
import { loadEnv } from './config/env.js'

configureDnsForMongoSrv()

async function main() {
  const env = loadEnv()
  const app = await buildApp()

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'Shutting down')
    await app.close()
    process.exit(0)
  }

  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  await app.listen({ host: env.HOST, port: env.PORT })
  if (env.LUMI_AUTOMATION_ENABLED) {
    app.ctx.automation.start()
    app.ctx.initiatives.start()
    app.log.info(`Lumi automation scheduler started (tick ${env.LUMI_AUTOMATION_TICK_MS} ms)`)
  }
  app.log.info(`Lumi API listening on ${env.HOST}:${env.PORT}`)
  app.log.info(`Public URL: ${env.APP_URL}`)
  app.log.info(`Swagger: ${env.APP_URL}/docs`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

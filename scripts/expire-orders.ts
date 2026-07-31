/**
 * Expira órdenes impagas según TTL configurado.
 * Uso: npm run expire:orders
 */
import { loadEnv } from '../src/config/env.js'
import { createScriptLogger } from '../src/config/logger.js'
import { createAppContext, shutdownAppContext } from '../src/app.context.js'

async function main() {
  const env = loadEnv()
  const logger = createScriptLogger()
  const ctx = await createAppContext(env, logger)

  try {
    const ttlHours = env.ORDER_MANUAL_PAYMENT_TTL_HOURS
    const cutoff = new Date(Date.now() - ttlHours * 60 * 60 * 1000)
    const expiredOrders = await ctx.repos.orders.expireUnpaidOrders(cutoff)

    const expiredPayments = await ctx.repos.payments.findExpiredPendingPayments(cutoff)
    for (const payment of expiredPayments) {
      if (!payment._id) continue
      await ctx.repos.payments.updatePaymentStatus(payment._id, 'cancelled', 'expired_by_ttl')
      await ctx.repos.payments.addPaymentEvent(
        payment._id,
        {
          type: 'payment.expired',
          timestamp: new Date(),
          source: 'system',
          data: { ttlHours },
        },
      )
    }

    logger.info(
      { expiredOrders, expiredPayments: expiredPayments.length, ttlHours, cutoff: cutoff.toISOString() },
      'expire-orders completed',
    )
  } finally {
    await shutdownAppContext(ctx)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../app.context.js'
import { AppError } from '../common/errors/app.error.js'
import {
  registerPushDeviceSchema,
  unregisterPushDeviceSchema,
} from '../modules/notifications/schemas/lumichat.schema.js'

function lumichatDeviceKeyGuard(deviceKey: string | undefined) {
  return async (request: import('fastify').FastifyRequest) => {
    const header = request.headers['x-lumi-device-key']
    const provided = typeof header === 'string' ? header : ''
    if (!deviceKey || provided !== deviceKey) {
      throw AppError.unauthorized('Invalid device registration key')
    }
  }
}

export async function registerLumichatRoutes(api: FastifyInstance, ctx: AppContext) {
  const { services, env } = ctx
  const guard = lumichatDeviceKeyGuard(env.LUMICHAT_DEVICE_KEY)

  api.post('/lumichat/devices/register', {
    preHandler: guard,
    schema: {
      tags: ['lumichat'],
      summary: 'Register FCM device token (LumiChat app)',
      headers: {
        type: 'object',
        required: ['x-lumi-device-key'],
        properties: { 'x-lumi-device-key': { type: 'string' } },
      },
      body: {
        type: 'object',
        required: ['fcmToken'],
        properties: {
          fcmToken: { type: 'string' },
          platform: { type: 'string', enum: ['android', 'ios'] },
          deviceLabel: { type: 'string' },
        },
      },
    },
  }, async (request) => {
    const parsed = registerPushDeviceSchema.safeParse(request.body)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    await services.push.registerDevice(parsed.data)
    return { ok: true }
  })

  api.post('/lumichat/devices/unregister', {
    preHandler: guard,
    schema: {
      tags: ['lumichat'],
      summary: 'Unregister FCM device token',
      headers: {
        type: 'object',
        required: ['x-lumi-device-key'],
        properties: { 'x-lumi-device-key': { type: 'string' } },
      },
      body: {
        type: 'object',
        required: ['fcmToken'],
        properties: { fcmToken: { type: 'string' } },
      },
    },
  }, async (request) => {
    const parsed = unregisterPushDeviceSchema.safeParse(request.body)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    const ok = await services.push.unregisterDevice(parsed.data.fcmToken)
    return { ok }
  })
}

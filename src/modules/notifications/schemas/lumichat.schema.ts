import { z } from 'zod'

export const registerPushDeviceSchema = z.object({
  fcmToken: z.string().min(20).max(4096),
  platform: z.enum(['android', 'ios']).default('android'),
  deviceLabel: z.string().max(120).optional(),
})

export const unregisterPushDeviceSchema = z.object({
  fcmToken: z.string().min(20).max(4096),
})

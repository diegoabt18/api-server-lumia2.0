import { z } from 'zod'

export const registerSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(120),
  password: z.string().min(6).max(128),
})

export const profilePatchSchema = z.object({
  nickname: z.string().optional(),
  name: z.string().optional(),
  avatar: z.string().optional(),
  completeOnboarding: z.boolean().optional(),
})

export const notificationPreferencesSchema = z.object({
  promotions: z.boolean(),
  orderStatus: z.boolean(),
  newProducts: z.boolean(),
})

export const accountPreferencesPatchSchema = z.object({
  notificationPreferences: notificationPreferencesSchema.optional(),
  shippingAddresses: z
    .array(
      z.object({
        id: z.string().max(40).optional(),
        label: z.string().trim().max(40).optional(),
        recipientName: z.string().trim().min(2).max(120),
        phone: z.string().trim().min(8).max(24),
        address: z.string().trim().min(5).max(200),
        city: z.string().trim().min(2).max(80),
        reference: z.string().trim().min(1).max(200),
        isPrimary: z.boolean(),
      }),
    )
    .max(10)
    .optional(),
})

export const revokeSessionSchema = z.object({
  sessionId: z.string().trim().min(1),
})

export const markNotificationsReadSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(100),
})

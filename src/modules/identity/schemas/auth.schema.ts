import { z } from 'zod'

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  rememberMe: z.boolean().optional(),
})

export const refreshSchema = z.object({
  refreshToken: z.string().optional(),
})

export type LoginDto = z.infer<typeof loginSchema>

import { z } from 'zod'

export const twoFactorCodeSchema = z.object({
  code: z.string().min(6).max(8),
})

export const twoFactorVerifyLoginSchema = z.object({
  tempToken: z.string().min(1),
  code: z.string().min(6).max(8),
})

export const roleCreateSchema = z.object({
  key: z.string().min(2).max(64),
  name: z.string().min(2).max(120),
  description: z.string().max(500).optional(),
  permissionKeys: z.array(z.string()).default([]),
})

export const rolePatchSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  description: z.string().max(500).optional(),
  permissionKeys: z.array(z.string()).optional(),
})

export const assignRoleSchema = z.object({
  roleId: z.string().min(1),
})

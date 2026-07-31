import type { UserRole } from '../../../common/permissions/registry.js'

export interface UserShippingAddress {
  id: string
  label?: string
  recipientName: string
  phone: string
  address: string
  city: string
  reference: string
  isPrimary: boolean
}

export interface UserNotificationPreferences {
  promotions: boolean
  orderStatus: boolean
  newProducts: boolean
}

export interface UserTwoFactor {
  enabled: boolean
  secretEnc?: string
  pendingSecretEnc?: string
  confirmedAt?: Date
}

export interface UserEntity {
  _id?: string
  email: string
  name?: string
  nickname?: string
  passwordHash?: string
  role: UserRole
  isStaff?: boolean
  googleId?: string
  avatar?: string
  provider?: 'local' | 'google'
  isFirstLogin?: boolean
  twoFactor?: UserTwoFactor
  notificationPreferences?: UserNotificationPreferences
  shippingAddresses?: UserShippingAddress[]
  permissionsVersion?: number
  permissionUpdatedAt?: Date
  createdAt?: Date
  updatedAt?: Date
}

export interface UserDomain {
  id: string
  email: string
  name?: string
  nickname?: string
  role: UserRole
  isStaff?: boolean
  avatar?: string
  provider?: 'local' | 'google'
  isFirstLogin?: boolean
  notificationPreferences?: UserNotificationPreferences
  shippingAddresses?: UserShippingAddress[]
  permissionsVersion?: number
  permissionUpdatedAt?: string
  createdAt?: string
}

export function toUserDomain(entity: UserEntity): UserDomain {
  return {
    id: entity._id!,
    email: entity.email,
    name: entity.name,
    nickname: entity.nickname,
    role: entity.role ?? 'user',
    isStaff: entity.isStaff,
    avatar: entity.avatar,
    provider: entity.provider,
    isFirstLogin: entity.isFirstLogin,
    notificationPreferences: entity.notificationPreferences,
    shippingAddresses: entity.shippingAddresses,
    permissionsVersion: entity.permissionsVersion ?? 1,
    permissionUpdatedAt: entity.permissionUpdatedAt?.toISOString(),
    createdAt: entity.createdAt?.toISOString(),
  }
}

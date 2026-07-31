export type SessionDeviceType = 'desktop' | 'mobile' | 'tablet' | 'unknown'

export interface SessionEntity {
  _id?: string
  userId: string
  refreshTokenHash: string
  deviceId: string
  tokenFamilyId: string
  parentTokenId?: string | null
  ipAddress?: string
  userAgent?: string
  deviceName?: string
  browser?: string
  os?: string
  deviceType?: SessionDeviceType
  expiresAt: Date
  revokedAt?: Date | null
  replacedByTokenId?: string | null
  createdAt: Date
  lastUsedAt: Date
  lastRefreshAt?: Date
  lastCountry?: string | null
  reuseDetected?: boolean
  suspicious?: boolean
  riskScore?: number
  isActive?: boolean
  permissionsVersion?: number
  permissionUpdatedAt?: Date
}

export interface AccessTokenPayload {
  userId: string
  role: string
  sessionId: string
  permHash: string
  permissionsVersion: number
  issuedAtMs?: number
}

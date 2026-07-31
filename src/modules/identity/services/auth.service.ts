import bcrypt from 'bcryptjs'
import { randomUUID } from 'node:crypto'
import { AppError } from '../../../common/errors/app.error.js'
import {
  buildAuthzSnapshot,
  resolvePermissionsForRole,
  type UserRole,
} from '../../../common/permissions/registry.js'
import {
  buildDeviceId,
  generateRefreshToken,
  hashRefreshToken,
  newTokenFamilyId,
  parseDurationMs,
  parseUserAgent,
} from '../../../common/utils/crypto.utils.js'
import { getEnv } from '../../../config/env.js'
import type { UserDomain, UserEntity, UserShippingAddress } from '../domain/user.entity.js'
import { toUserDomain } from '../domain/user.entity.js'
import { JwtTokenService } from '../infrastructure/jwt.service.js'
import { SessionRepository } from '../infrastructure/session.repository.js'
import { UserRepository } from '../infrastructure/user.repository.js'
import {
  generateRandomNickname,
  isNicknameValid,
  sanitizeNickname,
} from '../utils/nickname.utils.js'
import type { AuthAuditRepository } from '../infrastructure/auth-audit.repository.js'
import type { TwoFactorService } from './two-factor.service.js'
import type { AuthorizationService } from '../../security/services/authorization.service.js'

export type LoginResult =
  | { requires2fa: true; tempToken: string }
  | {
      accessToken: string
      refreshToken: string
      accessExpiresAtMs: number
      user: UserDomain
      permHash: string
      permissionsVersion: number
      permissionKeys: import('../../../common/permissions/registry.js').PermissionId[]
      refreshMaxAgeSeconds: number
    }

export class AuthService {
  constructor(
    private readonly users: UserRepository,
    private readonly sessions: SessionRepository,
    private readonly jwt: JwtTokenService,
    private readonly authAudit?: AuthAuditRepository,
    private readonly twoFactor?: TwoFactorService,
    private readonly authorization?: AuthorizationService,
  ) {}

  async login(params: {
    email: string
    password: string
    rememberMe?: boolean
    userAgent?: string
    ip?: string
    country?: string | null
    acceptLanguage?: string
  }): Promise<LoginResult> {
    const env = getEnv()
    if (!env.AUTH_LOCAL_ENABLED) {
      throw AppError.forbidden('El acceso con email y contraseña no está disponible.')
    }

    const user = await this.users.findByEmail(params.email)
    if (!user?.passwordHash) {
      await this.authAudit?.log({
        event: 'LOGIN_FAILED',
        email: params.email,
        ip: params.ip ?? null,
        userAgent: params.userAgent ?? null,
      })
      throw AppError.unauthorized('Invalid credentials')
    }

    const valid = await bcrypt.compare(params.password, user.passwordHash)
    if (!valid) {
      await this.authAudit?.log({
        event: 'LOGIN_FAILED',
        userId: user._id,
        email: user.email,
        ip: params.ip ?? null,
        userAgent: params.userAgent ?? null,
      })
      throw AppError.unauthorized('Invalid credentials')
    }

    if (this.twoFactor?.isTwoFactorEnabled(user)) {
      const tempToken = this.twoFactor.createLoginTempToken(user._id!, {
        rememberMe: params.rememberMe,
        userAgent: params.userAgent,
        ip: params.ip,
        country: params.country,
        acceptLanguage: params.acceptLanguage,
      })
      return { requires2fa: true as const, tempToken }
    }

    const tokens = await this.issueTokensForUser(user, {
      rememberMe: params.rememberMe,
      userAgent: params.userAgent,
      ip: params.ip,
      country: params.country,
      acceptLanguage: params.acceptLanguage,
    })

    await this.authAudit?.log({
      event: 'LOGIN_SUCCESS',
      userId: user._id,
      email: user.email,
      ip: params.ip ?? null,
      userAgent: params.userAgent ?? null,
    })

    return tokens
  }

  async refresh(refreshToken: string, _meta: { ip?: string; userAgent?: string; country?: string | null }) {
    const hash = hashRefreshToken(refreshToken)
    const session = await this.sessions.findByRefreshHash(hash)

    if (!session || session.expiresAt.getTime() <= Date.now()) {
      throw AppError.unauthorized('Invalid refresh token')
    }

    if (session.revokedAt || session.isActive === false) {
      await this.sessions.revokeFamily(session.tokenFamilyId)
      throw AppError.unauthorized('Refresh token reuse detected', 'REUSE_DETECTED')
    }

    const user = await this.users.findByIdSafe(session.userId)
    if (!user) {
      throw AppError.unauthorized('Invalid refresh token')
    }

    const role = (user.role ?? 'user') as UserRole
    const authz = this.authorization
      ? await this.authorization.buildAuthzSnapshot(user._id!, role, user.permissionsVersion ?? 1)
      : buildAuthzSnapshot(role)
    const env = getEnv()
    const refreshTtlMs = parseDurationMs(env.JWT_REFRESH_EXPIRES_IN, 7 * 86400000)

    const newRefresh = generateRefreshToken()
    const newHash = hashRefreshToken(newRefresh)
    const newExpiresAt = new Date(Date.now() + refreshTtlMs)

    await this.sessions.rotateRefresh(session._id!, newHash, newExpiresAt)

    const accessToken = this.jwt.signAccess(
      this.jwt.buildAccessPayload({
        userId: user._id!,
        role,
        sessionId: session._id!,
        permHash: authz.permHash,
        permissionsVersion: authz.permissionsVersion,
      }),
    )

    return {
      accessToken,
      refreshToken: newRefresh,
      accessExpiresAtMs: this.jwt.getAccessExpiresAtMs(accessToken) ?? Date.now() + 600000,
      user: toUserDomain(user),
      permHash: authz.permHash,
      permissionsVersion: authz.permissionsVersion,
      refreshMaxAgeSeconds: Math.floor(refreshTtlMs / 1000),
    }
  }

  async logout(refreshToken?: string, meta?: { ip?: string; userAgent?: string; userId?: string; email?: string }): Promise<void> {
    if (!refreshToken) return
    const hash = hashRefreshToken(refreshToken)
    const session = await this.sessions.findByRefreshHash(hash)
    if (session?._id) {
      await this.sessions.revokeSession(session._id)
      const user = meta?.userId ? null : await this.users.findByIdSafe(session.userId)
      await this.authAudit?.log({
        event: 'LOGOUT',
        userId: meta?.userId ?? session.userId,
        email: meta?.email ?? user?.email ?? null,
        ip: meta?.ip ?? null,
        userAgent: meta?.userAgent ?? null,
      })
    }
  }

  async getMe(userId: string): Promise<UserDomain> {
    const user = await this.users.findByIdSafe(userId)
    if (!user) throw AppError.notFound('User not found')
    return toUserDomain(user)
  }

  async register(params: {
    name: string
    email: string
    password: string
    userAgent?: string
    ip?: string
    country?: string | null
    acceptLanguage?: string
  }) {
    const env = getEnv()
    if (!env.AUTH_LOCAL_ENABLED) {
      throw AppError.forbidden('El registro con email no está disponible. Usa Continuar con Google.')
    }

    const existing = await this.users.findByEmail(params.email)
    if (existing) throw AppError.conflict('Email already registered')

    let nickname = generateRandomNickname()
    for (let i = 0; i < 5; i++) {
      const taken = await this.users.findByNickname(nickname)
      if (!taken) break
      nickname = generateRandomNickname()
    }

    const passwordHash = await bcrypt.hash(params.password, 12)
    const user = await this.users.createUser({
      email: params.email,
      name: params.name,
      passwordHash,
      nickname,
    })

    const tokens = await this.issueTokensForUser(user, {
      rememberMe: true,
      userAgent: params.userAgent,
      ip: params.ip,
      country: params.country,
      acceptLanguage: params.acceptLanguage,
    })

    return {
      user: tokens.user,
      permHash: tokens.permHash,
      permissionsVersion: tokens.permissionsVersion,
      accessExpiresAt: tokens.accessExpiresAtMs,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      refreshMaxAgeSeconds: tokens.refreshMaxAgeSeconds,
    }
  }

  async checkNicknameAvailability(raw: string) {
    const nickname = sanitizeNickname(raw)
    if (!nickname) return { nickname: '', available: false, valid: false }
    const valid = isNicknameValid(nickname)
    if (!valid) return { nickname, available: false, valid: false }
    const exists = await this.users.findByNickname(nickname)
    return { nickname, available: !exists, valid: true }
  }

  async updateProfile(
    userId: string,
    patch: {
      nickname?: string
      name?: string
      avatar?: string
      completeOnboarding?: boolean
    },
  ) {
    const current = await this.users.findByIdSafe(userId)
    if (!current) throw AppError.notFound('User not found')

    const update: Parameters<UserRepository['updateProfile']>[1] = {}

    if (patch.nickname !== undefined) {
      const nickname = sanitizeNickname(patch.nickname)
      if (!isNicknameValid(nickname)) {
        throw AppError.badRequest('Nickname inválido. Usa 3-24 caracteres: letras, números o underscore.')
      }
      const exists = await this.users.findByNickname(nickname)
      if (exists && exists._id !== userId) {
        throw AppError.conflict('Este nickname ya está en uso')
      }
      update.nickname = nickname
    }

    if (patch.name !== undefined) {
      const name = patch.name.trim()
      if (name.length < 2) throw AppError.badRequest('El nombre debe tener al menos 2 caracteres.')
      if (name.length > 120) throw AppError.badRequest('El nombre es demasiado largo.')
      update.name = name
    }

    if (patch.avatar !== undefined) {
      const raw = patch.avatar.trim()
      if (!raw) update.avatar = ''
      else if (raw.length > 2048) throw AppError.badRequest('URL de imagen demasiado larga.')
      else if (!/^https:\/\//i.test(raw)) throw AppError.badRequest('La foto debe ser una URL https válida.')
      else update.avatar = raw
    }

    if (patch.completeOnboarding === true) update.isFirstLogin = false

    if (Object.keys(update).length === 0) return { user: toUserDomain(current) }

    const updated = await this.users.updateProfile(userId, update)
    if (!updated) throw AppError.internal('No se pudo actualizar el perfil')
    return { user: toUserDomain(updated) }
  }

  async updatePreferences(
    userId: string,
    patch: {
      notificationPreferences?: UserEntity['notificationPreferences']
      shippingAddresses?: Array<Omit<UserShippingAddress, 'id'> & { id?: string }>
    },
  ) {
    const current = await this.users.findByIdSafe(userId)
    if (!current) throw AppError.notFound('Usuario no encontrado')

    const update: Parameters<UserRepository['updateProfile']>[1] = {}
    if (patch.notificationPreferences !== undefined) {
      update.notificationPreferences = patch.notificationPreferences
    }
    if (patch.shippingAddresses !== undefined) {
      update.shippingAddresses = normalizeAddresses(patch.shippingAddresses)
    }

    if (Object.keys(update).length === 0) return { user: toUserDomain(current) }

    const updated = await this.users.updateProfile(userId, update)
    if (!updated) throw AppError.internal('No se pudo guardar')
    return { user: toUserDomain(updated) }
  }

  async listSessions(userId: string) {
    const sessions = await this.sessions.listActiveByUserId(userId)
    return {
      sessions: sessions.map((s) => ({
        sessionId: s._id!,
        deviceId: s.deviceId,
        deviceName: s.deviceName ?? s.userAgent ?? 'Unknown device',
        browser: s.browser,
        os: s.os,
        deviceType: s.deviceType ?? 'unknown',
        ip: s.ipAddress ?? null,
        lastUsedAt: s.lastUsedAt.toISOString(),
        lastRefreshAt: s.lastRefreshAt?.toISOString() ?? null,
        suspicious: !!s.suspicious,
        riskScore: s.riskScore ?? 0,
      })),
    }
  }

  async revokeSession(userId: string, currentSessionId: string, sessionId: string) {
    if (sessionId === currentSessionId) {
      throw AppError.badRequest('Use logout to end the current session')
    }
    const ok = await this.sessions.revokeSessionIfOwned(sessionId, userId)
    if (!ok) throw AppError.notFound('Session not found')
    return { ok: true }
  }

  async logoutAll(userId: string, exceptCurrent?: boolean, currentSessionId?: string) {
    if (exceptCurrent && currentSessionId) {
      await this.sessions.revokeAllExcept(userId, currentSessionId)
    } else {
      await this.sessions.revokeAllByUserId(userId)
    }
    return { ok: true }
  }

  getPermissions(auth: { permHash: string; permissionsVersion: number; role: string }) {
    return {
      permissions: resolvePermissionsForRole(auth.role as UserRole),
      permHash: auth.permHash,
      permissionsVersion: auth.permissionsVersion,
    }
  }

  async getPermissionsForUser(userId: string, role: UserRole, permHash: string, permissionsVersion: number) {
    const permissions = this.authorization
      ? await this.authorization.resolveEffectivePermissions(userId, role)
      : resolvePermissionsForRole(role)
    return { permissions, permHash, permissionsVersion }
  }

  /** Expuesto para Google OAuth */
  async issueTokensForGoogleUser(
    user: { _id?: string; role?: UserRole; email: string; nickname?: string },
    meta: {
      userAgent?: string
      ip?: string
      acceptLanguage?: string
    },
  ) {
    return this.issueTokensForUser(user, { ...meta, rememberMe: true })
  }

  /** Expuesto para Google OAuth y 2FA verify */
  async issueTokensForUser(
    user: { _id?: string; role?: UserRole; email: string; nickname?: string },
    meta: {
      rememberMe?: boolean
      userAgent?: string
      ip?: string
      country?: string | null
      acceptLanguage?: string
    },
  ) {
    const env = getEnv()
    const role = (user.role ?? 'user') as UserRole
    const permissionsVersion = 'permissionsVersion' in user && typeof user.permissionsVersion === 'number'
      ? user.permissionsVersion
      : 1
    const authz = this.authorization
      ? await this.authorization.buildAuthzSnapshot(user._id!, role, permissionsVersion)
      : buildAuthzSnapshot(role)
    const refreshTtlMs = meta.rememberMe
      ? parseDurationMs(env.JWT_REFRESH_REMEMBER_EXPIRES_IN, 30 * 86400000)
      : parseDurationMs(env.JWT_REFRESH_EXPIRES_IN, 7 * 86400000)

    const deviceId = buildDeviceId(meta.userAgent, { acceptLanguage: meta.acceptLanguage })
    const parsed = parseUserAgent(meta.userAgent)
    const plainRefresh = generateRefreshToken()
    const refreshHash = hashRefreshToken(plainRefresh)
    const expiresAt = new Date(Date.now() + refreshTtlMs)

    await this.sessions.revokeSessionsForUserDevice(user._id!, deviceId)

    const { sessionId } = await this.sessions.create({
      userId: user._id!,
      refreshTokenHash: refreshHash,
      deviceId,
      tokenFamilyId: newTokenFamilyId(),
      parentTokenId: null,
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
      deviceName: parsed.deviceName,
      browser: parsed.browser,
      os: parsed.os,
      deviceType: parsed.deviceType,
      expiresAt,
      revokedAt: null,
      replacedByTokenId: null,
      lastCountry: meta.country ?? null,
      permissionsVersion: authz.permissionsVersion,
      permissionUpdatedAt: authz.permissionUpdatedAt,
    })

    const accessToken = this.jwt.signAccess(
      this.jwt.buildAccessPayload({
        userId: user._id!,
        role,
        sessionId,
        permHash: authz.permHash,
        permissionsVersion: authz.permissionsVersion,
      }),
    )

    return {
      accessToken,
      refreshToken: plainRefresh,
      accessExpiresAtMs: this.jwt.getAccessExpiresAtMs(accessToken) ?? Date.now() + 600000,
      user: toUserDomain({ ...user, _id: user._id!, role } as UserEntity),
      permHash: authz.permHash,
      permissionsVersion: authz.permissionsVersion,
      permissionKeys: authz.permissionKeys,
      refreshMaxAgeSeconds: Math.floor(refreshTtlMs / 1000),
    }
  }
}

function normalizeAddresses(
  rows: Array<Omit<UserShippingAddress, 'id'> & { id?: string }>,
): UserShippingAddress[] {
  if (!rows.length) return []
  const withIds = rows.map((r) => ({
    ...r,
    id: r.id && r.id.length ? r.id : randomUUID(),
  }))
  const primaryCount = withIds.filter((x) => x.isPrimary).length
  if (primaryCount === 0) return withIds.map((x, i) => ({ ...x, isPrimary: i === 0 }))
  if (primaryCount === 1) return withIds
  let seen = false
  return withIds.map((x) => {
    if (x.isPrimary && !seen) {
      seen = true
      return x
    }
    return { ...x, isPrimary: false }
  })
}

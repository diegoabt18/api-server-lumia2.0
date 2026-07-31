import QRCode from 'qrcode'
import { generateSecret, generateURI, verify } from 'otplib'
import { AppError } from '../../../common/errors/app.error.js'
import { getEnv } from '../../../config/env.js'
import type { UserRepository } from '../../identity/infrastructure/user.repository.js'
import type { TwoFactorRepository } from '../infrastructure/two-factor.repository.js'
import {
  decryptTwoFactorSecret,
  encryptTwoFactorSecret,
} from '../../identity/utils/two-factor-crypto.utils.js'
import {
  signTwoFactorTempToken,
  verifyTwoFactorTempToken,
} from '../../identity/infrastructure/jwt-2fa.js'
import type { AuthService } from '../../identity/services/auth.service.js'
import type { AuthAuditRepository } from '../infrastructure/auth-audit.repository.js'
import {
  generateBackupCodes,
  hashBackupCode,
} from '../utils/backup-codes.utils.js'

export class TwoFactorService {
  constructor(
    private readonly users: UserRepository,
    private readonly twoFactor: TwoFactorRepository,
    private readonly authAudit: AuthAuditRepository,
    private readonly getAuthService: () => AuthService,
  ) {}

  async setup(userId: string) {
    const user = await this.users.findByIdSafe(userId)
    if (!user) throw AppError.notFound('User not found')
    if (user.role !== 'admin') {
      throw AppError.forbidden('2FA setup is only available for admin accounts')
    }

    const secret = generateSecret()
    const secretEnc = encryptTwoFactorSecret(secret)
    await this.twoFactor.setPendingSecret(userId, secretEnc)

    const env = getEnv()
    const otpauthUrl = generateURI({
      issuer: env.APP_NAME,
      label: user.email,
      secret,
    })
    const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl)

    return {
      otpauthUrl,
      qrCodeDataUrl,
      secret,
    }
  }

  async confirmSetup(userId: string, code: string) {
    const pendingEnc = await this.twoFactor.getPendingSecretEnc(userId)
    if (!pendingEnc) throw AppError.badRequest('No hay configuración 2FA pendiente')

    const secret = decryptTwoFactorSecret(pendingEnc)
    const result = await verify({ secret, token: code })
    if (!result.valid) throw AppError.badRequest('Código 2FA inválido')

    await this.twoFactor.confirmSetup(userId, pendingEnc)
    const backupCodes = generateBackupCodes()
    await this.twoFactor.updateBackupCodes(
      userId,
      backupCodes.map(hashBackupCode),
      backupCodes.length,
    )
    return { ok: true, enabled: true, backupCodes }
  }

  async disable(userId: string, code: string) {
    const secretEnc = await this.twoFactor.getSecretEnc(userId)
    if (!secretEnc) throw AppError.badRequest('2FA no está activo')

    const secret = decryptTwoFactorSecret(secretEnc)
    const result = await verify({ secret, token: code })
    if (!result.valid) throw AppError.badRequest('Código 2FA inválido')

    await this.twoFactor.disable(userId)
    return { ok: true, enabled: false }
  }

  async verifyLogin(params: {
    tempToken: string
    code: string
    ip?: string
    userAgent?: string
  }) {
    const payload = verifyTwoFactorTempToken(params.tempToken)
    if (!payload) throw AppError.unauthorized('Token 2FA inválido o expirado')

    const secretEnc = await this.twoFactor.getSecretEnc(payload.userId)
    if (!secretEnc) throw AppError.badRequest('2FA no configurado')

    const user = await this.users.findByIdSafe(payload.userId)
    if (!user) throw AppError.unauthorized('Usuario no encontrado')

    const secret = decryptTwoFactorSecret(secretEnc)
    const result = await verify({ secret, token: params.code })
    if (!result.valid) {
      await this.authAudit.log({
        event: 'LOGIN_2FA_FAILED',
        userId: user._id,
        email: user.email,
        ip: params.ip ?? payload.ip ?? null,
        userAgent: params.userAgent ?? payload.userAgent ?? null,
      })
      throw AppError.unauthorized('Código 2FA inválido')
    }

    const tokens = await this.getAuthService().issueTokensForUser(user, {
      rememberMe: payload.rememberMe,
      userAgent: payload.userAgent ?? params.userAgent,
      ip: payload.ip ?? params.ip,
      country: payload.country,
      acceptLanguage: payload.acceptLanguage,
    })

    await this.authAudit.log({
      event: 'LOGIN_SUCCESS',
      userId: user._id,
      email: user.email,
      ip: params.ip ?? payload.ip ?? null,
      userAgent: params.userAgent ?? payload.userAgent ?? null,
      metadata: { via2fa: true },
    })

    return tokens
  }

  isTwoFactorEnabled(user: { twoFactor?: { enabled?: boolean } }): boolean {
    return !!user.twoFactor?.enabled
  }

  createLoginTempToken(
    userId: string,
    meta: {
      rememberMe?: boolean
      userAgent?: string
      ip?: string
      country?: string | null
      acceptLanguage?: string
    },
  ) {
    return signTwoFactorTempToken({ userId, ...meta })
  }

  async getStatus(userId: string) {
    const status = await this.twoFactor.getStatus(userId)
    return status ?? { enabled: false, confirmedAt: null, remainingBackupCodes: 0 }
  }

  async listEnabledUsers(limit = 100) {
    const userIds = await this.twoFactor.findUserIdsWith2faEnabled(limit)
    const users = await Promise.all(
      userIds.map(async (id) => {
        const user = await this.users.findByIdSafe(id)
        const status = await this.twoFactor.getStatus(id)
        return user
          ? {
              userId: id,
              email: user.email,
              name: user.name ?? null,
              enabled: status?.enabled ?? false,
              remainingBackupCodes: status?.remainingBackupCodes ?? 0,
            }
          : null
      }),
    )
    return { items: users.filter(Boolean), total: users.filter(Boolean).length }
  }

  async listEnabledUserIds(limit = 100): Promise<string[]> {
    return this.twoFactor.findUserIdsWith2faEnabled(limit)
  }

  async regenerateBackupCodes(userId: string) {
    const secretEnc = await this.twoFactor.getSecretEnc(userId)
    if (!secretEnc) throw AppError.badRequest('2FA no está activo')
    const backupCodes = generateBackupCodes()
    await this.twoFactor.updateBackupCodes(
      userId,
      backupCodes.map(hashBackupCode),
      backupCodes.length,
    )
    return { backupCodes }
  }

  /** Formato compatible con el panel admin de lumia (setup → verify-setup). */
  async setupForLumiaAdmin(userId: string) {
    const result = await this.setup(userId)
    const secretEncrypted = await this.twoFactor.getPendingSecretEnc(userId)
    if (!secretEncrypted) throw AppError.internal('No se pudo iniciar configuración 2FA')
    const backupCodes = generateBackupCodes()
    return {
      secret: result.secret,
      secretEncrypted,
      uri: result.otpauthUrl,
      qrDataUrl: result.qrCodeDataUrl,
      backupCodes,
    }
  }

  async verifySetupForLumiaAdmin(
    userId: string,
    params: { code: string; secretEncrypted: string; backupCodes: string[] },
  ) {
    const pendingEnc = await this.twoFactor.getPendingSecretEnc(userId)
    const secretEnc = pendingEnc ?? params.secretEncrypted
    if (!secretEnc) throw AppError.badRequest('No hay configuración 2FA pendiente')

    const secret = decryptTwoFactorSecret(secretEnc)
    const result = await verify({ secret, token: params.code })
    if (!result.valid) throw AppError.badRequest('Código inválido. Intenta de nuevo.')

    await this.twoFactor.confirmSetup(userId, secretEnc)
    await this.twoFactor.updateBackupCodes(
      userId,
      params.backupCodes.map(hashBackupCode),
      params.backupCodes.length,
    )
    return { success: true }
  }

  /** Desactiva 2FA sin código (panel admin lumia). */
  async disableForLumiaAdmin(userId: string) {
    await this.twoFactor.disable(userId)
    return { success: true }
  }
}

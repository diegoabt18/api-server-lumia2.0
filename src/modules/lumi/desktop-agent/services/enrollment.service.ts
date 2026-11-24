import { AppError } from '../../../../common/errors/app.error.js'
import {
  ENROLLMENT_TTL_MS,
  REGISTRATION_CHALLENGE_TTL_MS,
  generateEnrollmentCode,
  hashEnrollmentCode,
  newDeviceId,
  newId,
  newNonce,
  verifyEd25519,
  type DesktopDevice,
} from '../domain/device.js'
import { registrationSigningString } from '../domain/protocol.js'
import type {
  DesktopDeviceStore,
  DesktopEnrollmentStore,
  PendingRegistrationStore,
} from '../infrastructure/desktop-device.repository.js'
import type { z } from 'zod'
import type { registrationCompleteSchema, registrationStartSchema } from '../domain/device.js'

export interface EnrollmentDeps {
  devices: DesktopDeviceStore
  enrollments: DesktopEnrollmentStore
  registrations: PendingRegistrationStore
  now?: () => Date
}

/**
 * Alta de equipos en dos pasos con prueba de posesión de la clave:
 *  1. Lumia Admin genera un código de un solo uso (10 min) para su propietario.
 *  2. El agente envía código + clave pública y recibe un desafío (60 s).
 *  3. El agente firma el desafío; solo entonces se consume el código y se crea el equipo.
 * Las respuestas de error no distinguen "código inexistente" de "caducado" o "usado".
 */
export class DesktopEnrollmentService {
  private readonly now: () => Date

  constructor(private readonly deps: EnrollmentDeps) {
    this.now = deps.now ?? (() => new Date())
  }

  async createEnrollment(ownerUserId: string): Promise<{ code: string; expiresAt: string }> {
    const code = generateEnrollmentCode()
    const createdAt = this.now()
    const expiresAt = new Date(createdAt.getTime() + ENROLLMENT_TTL_MS)
    await this.deps.enrollments.create({
      codeHash: hashEnrollmentCode(code),
      ownerUserId,
      createdAt,
      expiresAt,
      consumedAt: null,
    })
    return { code, expiresAt: expiresAt.toISOString() }
  }

  async startRegistration(input: z.output<typeof registrationStartSchema>) {
    const now = this.now()
    const codeHash = hashEnrollmentCode(input.enrollment_code)
    const enrollment = await this.deps.enrollments.findValid(codeHash, now)
    if (!enrollment)
      throw AppError.unauthorized('Invalid or expired enrollment code', 'ENROLLMENT_INVALID')
    if (
      await this.deps.devices.findActiveByInstallationOrKey(input.installation_id, input.public_key)
    ) {
      throw new AppError(
        409,
        'This installation is already registered',
        'DEVICE_ALREADY_REGISTERED',
      )
    }
    const registration = {
      id: newId(),
      codeHash,
      installationId: input.installation_id,
      publicKey: input.public_key,
      deviceInfo: {
        name: input.device_info.name,
        os: input.device_info.os,
        osVersion: input.device_info.os_version,
        arch: input.device_info.arch,
        agentVersion: input.device_info.agent_version,
      },
      challenge: newNonce(),
      expiresAt: new Date(now.getTime() + REGISTRATION_CHALLENGE_TTL_MS),
    }
    await this.deps.registrations.create(registration)
    return {
      registration_id: registration.id,
      challenge: registration.challenge,
      expires_at: registration.expiresAt.toISOString(),
    }
  }

  async completeRegistration(input: z.output<typeof registrationCompleteSchema>) {
    const now = this.now()
    const registration = await this.deps.registrations.take(input.registration_id, now)
    if (!registration) throw AppError.unauthorized('Registration expired', 'REGISTRATION_INVALID')

    const message = registrationSigningString(
      registration.challenge,
      registration.installationId,
      registration.publicKey,
    )
    if (!verifyEd25519(registration.publicKey, message, input.signature)) {
      throw AppError.unauthorized('Invalid signature', 'REGISTRATION_INVALID')
    }
    // El código se consume solo con la firma válida: un intento fallido no quema el código.
    const enrollment = await this.deps.enrollments.consume(registration.codeHash, now)
    if (!enrollment)
      throw AppError.unauthorized('Invalid or expired enrollment code', 'ENROLLMENT_INVALID')

    const device: DesktopDevice = {
      id: newDeviceId(),
      ownerUserId: enrollment.ownerUserId,
      installationId: registration.installationId,
      publicKey: registration.publicKey,
      name: registration.deviceInfo.name,
      os: registration.deviceInfo.os,
      osVersion: registration.deviceInfo.osVersion,
      arch: registration.deviceInfo.arch,
      agentVersion: registration.deviceInfo.agentVersion,
      status: 'active',
      execution: 'active',
      capabilities: null,
      registeredAt: now,
      revokedAt: null,
      lastSeenAt: null,
    }
    try {
      await this.deps.devices.insert(device)
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        throw new AppError(
          409,
          'This installation is already registered',
          'DEVICE_ALREADY_REGISTERED',
        )
      }
      throw err
    }
    return { device_id: device.id, registration_status: 'active' as const }
  }
}

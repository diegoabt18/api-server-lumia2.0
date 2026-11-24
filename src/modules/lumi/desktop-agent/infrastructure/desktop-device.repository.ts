import type { Collection, Db } from 'mongodb'
import type { CapabilityReport } from '../domain/protocol.js'
import type { DesktopDevice, DeviceExecutionState, DeviceOs } from '../domain/device.js'

/** Inscripción pendiente: solo el hash del código, la persona que lo generó y su caducidad. */
export interface DesktopEnrollment {
  codeHash: string
  ownerUserId: string
  createdAt: Date
  expiresAt: Date
  consumedAt: Date | null
}

/** Registro a medio completar: el desafío que el agente debe firmar con su clave privada. */
export interface PendingRegistration {
  id: string
  codeHash: string
  installationId: string
  publicKey: string
  deviceInfo: { name: string; os: DeviceOs; osVersion: string; arch: string; agentVersion: string }
  challenge: string
  expiresAt: Date
}

export interface DeviceTouch {
  lastSeenAt?: Date
  agentVersion?: string
  execution?: DeviceExecutionState
  capabilities?: CapabilityReport
}

export interface DesktopDeviceStore {
  insert(device: DesktopDevice): Promise<void>
  findById(id: string): Promise<DesktopDevice | null>
  /** ¿Hay ya un equipo ACTIVO con esa instalación o esa clave? */
  findActiveByInstallationOrKey(
    installationId: string,
    publicKey: string,
  ): Promise<DesktopDevice | null>
  listByOwner(ownerUserId: string): Promise<DesktopDevice[]>
  rename(id: string, ownerUserId: string, name: string): Promise<DesktopDevice | null>
  /** Revoca un equipo activo del propietario. null si no existe, no es suyo o ya estaba revocado. */
  revoke(id: string, ownerUserId: string, now: Date): Promise<DesktopDevice | null>
  touch(id: string, patch: DeviceTouch): Promise<void>
}

export interface DesktopEnrollmentStore {
  create(enrollment: DesktopEnrollment): Promise<void>
  findValid(codeHash: string, now: Date): Promise<DesktopEnrollment | null>
  /** Marca el código como usado si sigue vigente. Solo una llamada concurrente puede ganar. */
  consume(codeHash: string, now: Date): Promise<DesktopEnrollment | null>
}

export interface PendingRegistrationStore {
  create(registration: PendingRegistration): Promise<void>
  /** Toma (y borra) el registro vigente: un desafío solo se puede responder una vez. */
  take(id: string, now: Date): Promise<PendingRegistration | null>
}

// ---------------------------------------------------------------------------------------------
// MongoDB (identity_db, como el resto de Lumi)
// ---------------------------------------------------------------------------------------------

type DeviceDocument = Omit<DesktopDevice, 'id'> & { _id: string }
type RegistrationDocument = Omit<PendingRegistration, 'id'> & { _id: string }

function toDevice(doc: DeviceDocument | null): DesktopDevice | null {
  if (!doc) return null
  const { _id, ...rest } = doc
  return { ...rest, id: _id }
}

export class MongoDesktopDeviceStore implements DesktopDeviceStore {
  private readonly collection: Collection<DeviceDocument>

  constructor(db: Db) {
    this.collection = db.collection<DeviceDocument>('desktop_devices')
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex(
      { ownerUserId: 1, registeredAt: -1 },
      { name: 'desktop_devices_owner' },
    )
    // Una instalación o una clave no pueden tener dos equipos activos a la vez.
    await this.collection.createIndex(
      { installationId: 1 },
      {
        unique: true,
        partialFilterExpression: { status: 'active' },
        name: 'desktop_devices_installation_active',
      },
    )
    await this.collection.createIndex(
      { publicKey: 1 },
      {
        unique: true,
        partialFilterExpression: { status: 'active' },
        name: 'desktop_devices_key_active',
      },
    )
  }

  async insert(device: DesktopDevice): Promise<void> {
    const { id, ...rest } = device
    await this.collection.insertOne({ ...rest, _id: id })
  }

  async findById(id: string): Promise<DesktopDevice | null> {
    return toDevice(await this.collection.findOne({ _id: id }))
  }

  async findActiveByInstallationOrKey(
    installationId: string,
    publicKey: string,
  ): Promise<DesktopDevice | null> {
    return toDevice(
      await this.collection.findOne({ status: 'active', $or: [{ installationId }, { publicKey }] }),
    )
  }

  async listByOwner(ownerUserId: string): Promise<DesktopDevice[]> {
    const docs = await this.collection
      .find({ ownerUserId })
      .sort({ registeredAt: -1 })
      .limit(100)
      .toArray()
    return docs.map((d) => toDevice(d) as DesktopDevice)
  }

  async rename(id: string, ownerUserId: string, name: string): Promise<DesktopDevice | null> {
    return toDevice(
      await this.collection.findOneAndUpdate(
        { _id: id, ownerUserId, status: 'active' },
        { $set: { name } },
        { returnDocument: 'after' },
      ),
    )
  }

  async revoke(id: string, ownerUserId: string, now: Date): Promise<DesktopDevice | null> {
    return toDevice(
      await this.collection.findOneAndUpdate(
        { _id: id, ownerUserId, status: 'active' },
        { $set: { status: 'revoked', revokedAt: now } },
        { returnDocument: 'after' },
      ),
    )
  }

  async touch(id: string, patch: DeviceTouch): Promise<void> {
    if (Object.keys(patch).length === 0) return
    await this.collection.updateOne({ _id: id, status: 'active' }, { $set: patch })
  }
}

export class MongoDesktopEnrollmentStore implements DesktopEnrollmentStore {
  private readonly collection: Collection<DesktopEnrollment>

  constructor(db: Db) {
    this.collection = db.collection<DesktopEnrollment>('desktop_enrollments')
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex(
      { codeHash: 1 },
      { unique: true, name: 'desktop_enrollments_code' },
    )
    await this.collection.createIndex(
      { expiresAt: 1 },
      { expireAfterSeconds: 0, name: 'desktop_enrollments_ttl' },
    )
  }

  async create(enrollment: DesktopEnrollment): Promise<void> {
    await this.collection.insertOne({ ...enrollment })
  }

  async findValid(codeHash: string, now: Date): Promise<DesktopEnrollment | null> {
    return this.collection.findOne(
      { codeHash, consumedAt: null, expiresAt: { $gt: now } },
      { projection: { _id: 0 } },
    )
  }

  async consume(codeHash: string, now: Date): Promise<DesktopEnrollment | null> {
    return this.collection.findOneAndUpdate(
      { codeHash, consumedAt: null, expiresAt: { $gt: now } },
      { $set: { consumedAt: now } },
      { returnDocument: 'after', projection: { _id: 0 } },
    )
  }
}

export class MongoPendingRegistrationStore implements PendingRegistrationStore {
  private readonly collection: Collection<RegistrationDocument>

  constructor(db: Db) {
    this.collection = db.collection<RegistrationDocument>('desktop_registrations')
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex(
      { expiresAt: 1 },
      { expireAfterSeconds: 0, name: 'desktop_registrations_ttl' },
    )
  }

  async create(registration: PendingRegistration): Promise<void> {
    const { id, ...rest } = registration
    await this.collection.insertOne({ ...rest, _id: id })
  }

  async take(id: string, now: Date): Promise<PendingRegistration | null> {
    const doc = await this.collection.findOneAndDelete({ _id: id })
    if (!doc || doc.expiresAt <= now) return null
    const { _id, ...rest } = doc
    return { ...rest, id: _id }
  }
}

// ---------------------------------------------------------------------------------------------
// Memoria (pruebas y desarrollo sin Mongo)
// ---------------------------------------------------------------------------------------------

export class MemoryDesktopDeviceStore implements DesktopDeviceStore {
  readonly items = new Map<string, DesktopDevice>()

  async insert(device: DesktopDevice): Promise<void> {
    if (await this.findActiveByInstallationOrKey(device.installationId, device.publicKey)) {
      throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 })
    }
    this.items.set(device.id, { ...device })
  }

  async findById(id: string): Promise<DesktopDevice | null> {
    const d = this.items.get(id)
    return d ? { ...d } : null
  }

  async findActiveByInstallationOrKey(
    installationId: string,
    publicKey: string,
  ): Promise<DesktopDevice | null> {
    for (const d of this.items.values()) {
      if (
        d.status === 'active' &&
        (d.installationId === installationId || d.publicKey === publicKey)
      )
        return { ...d }
    }
    return null
  }

  async listByOwner(ownerUserId: string): Promise<DesktopDevice[]> {
    return [...this.items.values()]
      .filter((d) => d.ownerUserId === ownerUserId)
      .sort((a, b) => b.registeredAt.getTime() - a.registeredAt.getTime())
      .map((d) => ({ ...d }))
  }

  async rename(id: string, ownerUserId: string, name: string): Promise<DesktopDevice | null> {
    const d = this.items.get(id)
    if (!d || d.ownerUserId !== ownerUserId || d.status !== 'active') return null
    d.name = name
    return { ...d }
  }

  async revoke(id: string, ownerUserId: string, now: Date): Promise<DesktopDevice | null> {
    const d = this.items.get(id)
    if (!d || d.ownerUserId !== ownerUserId || d.status !== 'active') return null
    d.status = 'revoked'
    d.revokedAt = now
    return { ...d }
  }

  async touch(id: string, patch: DeviceTouch): Promise<void> {
    const d = this.items.get(id)
    if (d && d.status === 'active') Object.assign(d, patch)
  }
}

export class MemoryDesktopEnrollmentStore implements DesktopEnrollmentStore {
  readonly items = new Map<string, DesktopEnrollment>()

  async create(enrollment: DesktopEnrollment): Promise<void> {
    this.items.set(enrollment.codeHash, { ...enrollment })
  }

  async findValid(codeHash: string, now: Date): Promise<DesktopEnrollment | null> {
    const e = this.items.get(codeHash)
    return e && e.consumedAt === null && e.expiresAt > now ? { ...e } : null
  }

  async consume(codeHash: string, now: Date): Promise<DesktopEnrollment | null> {
    const e = this.items.get(codeHash)
    if (!e || e.consumedAt !== null || e.expiresAt <= now) return null
    e.consumedAt = now
    return { ...e }
  }
}

export class MemoryPendingRegistrationStore implements PendingRegistrationStore {
  readonly items = new Map<string, PendingRegistration>()

  async create(registration: PendingRegistration): Promise<void> {
    this.items.set(registration.id, { ...registration })
  }

  async take(id: string, now: Date): Promise<PendingRegistration | null> {
    const r = this.items.get(id)
    this.items.delete(id)
    return r && r.expiresAt > now ? r : null
  }
}

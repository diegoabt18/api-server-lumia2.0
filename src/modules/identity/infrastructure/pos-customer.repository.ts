import { ObjectId, MongoServerError, type Db } from 'mongodb'
import { getCollection } from '../../../database/repositories/base.repository.js'

/**
 * Clientes de mostrador (POS) sin cuenta web. Viven en `identity_db.pos_customers`.
 * Se deduplican por teléfono o email normalizados; los índices únicos parciales
 * impiden duplicados aunque dos ventas se registren a la vez.
 */
export interface PosCustomerDocument {
  _id: ObjectId
  name: string
  email: string | null
  phone: string | null
  normalizedEmail: string | null
  normalizedPhone: string | null
  createdByUserId: string
  createdAt: Date
  updatedAt: Date
}

export interface PosCustomerRecord {
  id: string
  name: string
  email: string | null
  phone: string | null
}

export interface PosCustomerInput {
  name?: string | null
  email?: string | null
  phone?: string | null
}

export function normalizePhone(value: string | null | undefined): string | null {
  const digits = (value ?? '').replace(/\D/g, '')
  return digits.length >= 6 ? digits : null
}

export function normalizeEmail(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim().toLowerCase()
  return trimmed.length ? trimmed : null
}

function toRecord(doc: PosCustomerDocument): PosCustomerRecord {
  return {
    id: doc._id.toString(),
    name: doc.name,
    email: doc.email,
    phone: doc.phone,
  }
}

function isDuplicateKey(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === 11000
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export class PosCustomerRepository {
  constructor(private readonly db: Db) {}

  private collection() {
    return getCollection<PosCustomerDocument>(this.db, 'pos_customers')
  }

  async ensureIndexes(): Promise<void> {
    await this.collection().createIndexes([
      {
        key: { normalizedPhone: 1 },
        unique: true,
        partialFilterExpression: { normalizedPhone: { $type: 'string' } },
        name: 'uniq_pos_customer_phone',
      },
      {
        key: { normalizedEmail: 1 },
        unique: true,
        partialFilterExpression: { normalizedEmail: { $type: 'string' } },
        name: 'uniq_pos_customer_email',
      },
    ])
  }

  /**
   * Devuelve el cliente que coincide por teléfono o email; si no existe, lo crea.
   * Sin teléfono ni email no hay forma segura de deduplicar, así que siempre se crea.
   */
  async findOrCreate(input: PosCustomerInput, actorId: string): Promise<PosCustomerRecord> {
    const phone = normalizePhone(input.phone)
    const email = normalizeEmail(input.email)
    const name = (input.name ?? '').trim()

    if (phone || email) {
      const match = await this.collection().findOne({
        $or: [
          ...(phone ? [{ normalizedPhone: phone }] : []),
          ...(email ? [{ normalizedEmail: email }] : []),
        ],
      })
      if (match) return toRecord(match)
    }

    const now = new Date()
    const doc: Omit<PosCustomerDocument, '_id'> = {
      name: name || 'Consumidor final',
      email: input.email?.trim() || null,
      phone: input.phone?.trim() || null,
      normalizedEmail: email,
      normalizedPhone: phone,
      createdByUserId: actorId,
      createdAt: now,
      updatedAt: now,
    }
    try {
      const result = await this.collection().insertOne({ ...doc, _id: new ObjectId() } as PosCustomerDocument)
      return toRecord({ ...doc, _id: result.insertedId } as PosCustomerDocument)
    } catch (error) {
      // Otro registro con el mismo teléfono/email se creó en paralelo: reutilizarlo.
      if (!isDuplicateKey(error)) throw error
      const existing = await this.collection().findOne({
        $or: [
          ...(phone ? [{ normalizedPhone: phone }] : []),
          ...(email ? [{ normalizedEmail: email }] : []),
        ],
      })
      if (existing) return toRecord(existing)
      throw error
    }
  }

  async findById(id: string): Promise<PosCustomerRecord | null> {
    if (!ObjectId.isValid(id)) return null
    const doc = await this.collection().findOne({ _id: new ObjectId(id) })
    return doc ? toRecord(doc) : null
  }

  /** Búsqueda por tokens (AND entre palabras) en nombre, email y teléfono. */
  async search(term: string, limit: number): Promise<PosCustomerRecord[]> {
    const tokens = term.trim().split(/\s+/).filter(Boolean).slice(0, 5)
    if (!tokens.length) return []
    const filter = {
      $and: tokens.map((token) => {
        const rx = new RegExp(escapeRegex(token), 'i')
        return { $or: [{ name: rx }, { email: rx }, { phone: rx }] }
      }),
    }
    const docs = await this.collection().find(filter).sort({ name: 1 }).limit(limit).toArray()
    return docs.map(toRecord)
  }
}

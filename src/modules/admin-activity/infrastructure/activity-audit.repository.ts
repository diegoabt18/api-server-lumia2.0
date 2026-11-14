import type { Collection, Db, Filter } from 'mongodb'
import { getCollection } from '../../../database/repositories/base.repository.js'
import {
  computeHash,
  GENESIS_HASH,
  verifyChain,
  type ActivityRecord,
  type ChainCheck,
} from '../domain/activity-audit.js'

export const ACTIVITY_AUDIT_COLLECTION = 'admin_activity_audit'

export type NewActivityRecord = Omit<ActivityRecord, 'seq' | 'prevHash' | 'hash'>

export interface ActivityQuery {
  actorUserId?: string
  resourceType?: string
  resourceId?: string
  result?: ActivityRecord['result']
  from?: Date
  to?: Date
  page: number
  limit: number
}

/**
 * Registro de actividad administrativa: SOLO inserción. No hay métodos de actualización ni de
 * borrado. Cada registro lleva un número de secuencia único y un HMAC encadenado con el anterior,
 * así que modificar, insertar o borrar registros en la base se detecta con `verify()`.
 *
 * Las escrituras se serializan en el proceso; el índice único de `seq` evita bifurcaciones si
 * hubiera varias instancias (el insert duplicado se reintenta con la nueva cabeza de la cadena).
 */
export class ActivityAuditRepository {
  private readonly collection: Collection<ActivityRecord>
  private tail: Promise<unknown> = Promise.resolve()

  constructor(
    db: Db,
    private readonly signingKey: string,
  ) {
    this.collection = getCollection<ActivityRecord>(db, ACTIVITY_AUDIT_COLLECTION)
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndexes([
      { key: { seq: 1 }, name: 'activity_seq_unique', unique: true },
      { key: { at: -1 }, name: 'activity_at' },
      { key: { 'actor.userId': 1, at: -1 }, name: 'activity_actor' },
      { key: { 'resource.type': 1, 'resource.id': 1, at: -1 }, name: 'activity_resource' },
    ])
  }

  /** Añade un registro al final de la cadena. Las llamadas se encolan (orden de llegada). */
  append(entry: NewActivityRecord): Promise<ActivityRecord> {
    const run = this.tail.then(() => this.appendNow(entry))
    this.tail = run.catch(() => undefined)
    return run
  }

  private async appendNow(entry: NewActivityRecord, attempt = 0): Promise<ActivityRecord> {
    const head = await this.collection.findOne({}, { sort: { seq: -1 }, projection: { seq: 1, hash: 1 } })
    const base = {
      ...entry,
      seq: (head?.seq ?? 0) + 1,
      prevHash: head?.hash ?? GENESIS_HASH,
    }
    const record: ActivityRecord = { ...base, hash: computeHash(this.signingKey, base) }
    try {
      await this.collection.insertOne({ ...record })
      return record
    } catch (err) {
      if ((err as { code?: unknown }).code === 11000 && attempt < 5) return this.appendNow(entry, attempt + 1)
      throw err
    }
  }

  async list(query: ActivityQuery): Promise<{ items: ActivityRecord[]; total: number }> {
    const filter: Filter<ActivityRecord> = {}
    if (query.actorUserId) filter['actor.userId'] = query.actorUserId
    if (query.resourceType) filter['resource.type'] = query.resourceType
    if (query.resourceId) filter['resource.id'] = query.resourceId
    if (query.result) filter.result = query.result
    if (query.from || query.to) {
      filter.at = {
        ...(query.from ? { $gte: query.from } : {}),
        ...(query.to ? { $lte: query.to } : {}),
      }
    }
    const [items, total] = await Promise.all([
      this.collection
        .find(filter, { projection: { _id: 0 } })
        .sort({ seq: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .toArray(),
      this.collection.countDocuments(filter),
    ])
    return { items, total }
  }

  /** Recorre toda la cadena por lotes y comprueba secuencia, enlaces y HMAC. */
  async verify(batchSize = 500): Promise<ChainCheck> {
    let prev = GENESIS_HASH
    let seq = 1
    let checked = 0
    for (;;) {
      const batch = await this.collection
        .find({ seq: { $gte: seq } }, { projection: { _id: 0 } })
        .sort({ seq: 1 })
        .limit(batchSize)
        .toArray()
      if (!batch.length) break
      const result = verifyChain(this.signingKey, batch, prev, seq)
      if (!result.ok) return { ...result, checked: checked + result.checked }
      checked += batch.length
      const last = batch[batch.length - 1]!
      prev = last.hash
      seq = last.seq + 1
    }
    return { ok: true, checked, brokenAtSeq: null, reason: null }
  }
}

/**
 * Registro de actividad administrativa contra MongoDB real (base temporal que se borra al final).
 *
 *   MONGO_TEST_URI=mongodb://127.0.0.1:27018 npm run test:integration
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoClient, type Db } from 'mongodb'
import {
  ACTIVITY_AUDIT_COLLECTION,
  ActivityAuditRepository,
  type NewActivityRecord,
} from '../../src/modules/admin-activity/infrastructure/activity-audit.repository.js'

const uri = process.env.MONGO_TEST_URI
const describeIfDb = uri ? describe : describe.skip
const KEY = 'integration-audit-key-'.repeat(3)

function entry(i: number): NewActivityRecord {
  return {
    at: new Date(),
    actor: { userId: 'u1', ip: '203.0.113.9', userAgent: 'it' },
    action: 'PATCH /api/admin/products/:id',
    resource: { type: 'product', id: `p${i}` },
    input: { price: i },
    changes: { price: { before: 0, after: i } },
    result: 'success',
    statusCode: 200,
    errorCode: null,
    requestId: `r${i}`,
  }
}

describeIfDb('admin activity audit (MongoDB real)', () => {
  let client: MongoClient
  let db: Db
  const dbName = `lumia_activity_${Date.now()}`

  beforeAll(async () => {
    client = new MongoClient(uri!)
    await client.connect()
    db = client.db(dbName)
  })

  afterAll(async () => {
    await db?.dropDatabase()
    await client?.close()
  })

  it('concurrent appends form one contiguous, verifiable chain', async () => {
    const repo = new ActivityAuditRepository(db, KEY)
    await repo.ensureIndexes()
    await Promise.all(Array.from({ length: 25 }, (_, i) => repo.append(entry(i))))
    const seqs = (await db.collection(ACTIVITY_AUDIT_COLLECTION).find().sort({ seq: 1 }).toArray()).map((d) => d.seq)
    expect(seqs).toEqual(Array.from({ length: 25 }, (_, i) => i + 1))
    expect(await repo.verify(7)).toMatchObject({ ok: true, checked: 25 })
  })

  it('two repository instances (two processes) do not fork the chain', async () => {
    const a = new ActivityAuditRepository(db, KEY)
    const b = new ActivityAuditRepository(db, KEY)
    await Promise.all([...Array.from({ length: 5 }, (_, i) => a.append(entry(100 + i))), ...Array.from({ length: 5 }, (_, i) => b.append(entry(200 + i)))])
    expect(await a.verify()).toMatchObject({ ok: true, checked: 35 })
  })

  it('detects a record modified directly in the database', async () => {
    const repo = new ActivityAuditRepository(db, KEY)
    await db.collection(ACTIVITY_AUDIT_COLLECTION).updateOne({ seq: 10 }, { $set: { 'actor.userId': 'someone-else' } })
    expect(await repo.verify()).toMatchObject({ ok: false, brokenAtSeq: 10, reason: 'Contenido alterado' })
  })

  it('detects a deleted record', async () => {
    const coll = db.collection(ACTIVITY_AUDIT_COLLECTION)
    // Se restaura la cadena desde cero con otra clave de prueba y se borra un registro.
    await coll.deleteMany({})
    const repo = new ActivityAuditRepository(db, KEY)
    for (let i = 0; i < 5; i++) await repo.append(entry(i))
    await coll.deleteOne({ seq: 3 })
    expect(await repo.verify()).toMatchObject({ ok: false, brokenAtSeq: 3 })
  })

  it('a different signing key cannot validate the chain', async () => {
    const coll = db.collection(ACTIVITY_AUDIT_COLLECTION)
    await coll.deleteMany({})
    const repo = new ActivityAuditRepository(db, KEY)
    for (let i = 0; i < 3; i++) await repo.append(entry(i))
    expect(await new ActivityAuditRepository(db, 'x'.repeat(64)).verify()).toMatchObject({ ok: false, brokenAtSeq: 1 })
  })
})

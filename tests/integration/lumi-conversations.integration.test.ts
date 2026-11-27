/**
 * Conversaciones de Lumi contra MongoDB real. Solo se ejecuta si MONGO_TEST_URI está definida:
 *   MONGO_TEST_URI=mongodb://127.0.0.1:27018 npm run test:integration
 * Usa una base temporal que se borra al terminar.
 */
import { randomUUID } from 'node:crypto'
import { MongoClient, type Db } from 'mongodb'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoConversationStore } from '../../src/modules/lumi/conversation/conversation.store.js'

const uri = process.env.MONGO_TEST_URI
const describeIfDb = uri ? describe : describe.skip
const NOW = new Date('2026-11-27T15:00:00.000Z')

describeIfDb('conversaciones de Lumi en MongoDB', () => {
  let client: MongoClient
  let db: Db
  let store: MongoConversationStore

  beforeAll(async () => {
    client = await MongoClient.connect(uri!)
    db = client.db(`lumi_conv_test_${Date.now()}`)
    store = new MongoConversationStore(db)
    await store.ensureIndexes()
  })

  afterAll(async () => {
    await db.dropDatabase()
    await client.close()
  })

  it('guarda turnos con seq consecutivo y los lee en orden', async () => {
    const id = randomUUID()
    expect(await store.ensure('u1', id, 'hola', NOW)).toBe(true)
    await store.appendExchange('u1', id, { message: 'hola', answer: 'r1', references: [] }, NOW)
    await store.appendExchange('u1', id, { message: 'otra', answer: 'r2', references: [] }, NOW)
    expect((await store.messages('u1', id)).map((m) => [m.seq, m.content])).toEqual([
      [1, 'hola'],
      [2, 'r1'],
      [3, 'otra'],
      [4, 'r2'],
    ])
    expect((await store.recent('u1', id, 2)).map((m) => m.content)).toEqual(['otra', 'r2'])
    expect((await store.find('u1', id))?.messageCount).toBe(4)
  })

  it('el id de otro usuario no se reutiliza ni se lee', async () => {
    const id = randomUUID()
    await store.ensure('u1', id, 'mía', NOW)
    expect(await store.ensure('u2', id, 'ajena', NOW)).toBe(false)
    expect(await store.find('u2', id)).toBeNull()
    expect(await store.delete('u2', id)).toBe(false)
  })

  it('reserva, reintento en curso, respuesta repetida y liberación', async () => {
    const id = randomUUID()
    await store.ensure('u1', id, 'hola', NOW)
    expect((await store.claim('u1', id, 'msg-00000001', NOW)).kind).toBe('claimed')
    expect((await store.claim('u1', id, 'msg-00000001', NOW)).kind).toBe('busy')
    // Mientras está reservada no aparece en el historial.
    expect(await store.messages('u1', id)).toEqual([])
    await store.appendExchange(
      'u1',
      id,
      { message: 'hola', answer: 'r1', references: [], clientMessageId: 'msg-00000001' },
      NOW,
    )
    const replay = await store.claim('u1', id, 'msg-00000001', NOW)
    expect(replay).toMatchObject({ kind: 'replay', answer: { content: 'r1', seq: 2 } })
    expect(await store.messages('u1', id)).toHaveLength(2)

    expect((await store.claim('u1', id, 'msg-00000002', NOW)).kind).toBe('claimed')
    await store.release('u1', id, 'msg-00000002')
    expect((await store.claim('u1', id, 'msg-00000002', NOW)).kind).toBe('claimed')
  })

  it('dos reservas simultáneas del mismo mensaje: solo una gana', async () => {
    const id = randomUUID()
    await store.ensure('u1', id, 'hola', NOW)
    const results = await Promise.all(
      Array.from({ length: 5 }, () => store.claim('u1', id, 'msg-00000003', NOW)),
    )
    expect(results.filter((r) => r.kind === 'claimed')).toHaveLength(1)
  })

  it('borrar elimina la conversación y sus mensajes', async () => {
    const id = randomUUID()
    await store.ensure('u1', id, 'hola', NOW)
    await store.appendExchange('u1', id, { message: 'hola', answer: 'r', references: [] }, NOW)
    expect(await store.delete('u1', id)).toBe(true)
    expect(await store.find('u1', id)).toBeNull()
    expect(await db.collection('lumi_messages').countDocuments({ conversationId: id })).toBe(0)
  })
})

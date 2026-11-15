/**
 * Fase F de Lumi: Learning Engine contra un MongoDB real y desechable.
 *
 *   MONGO_TEST_URI=mongodb://127.0.0.1:27018 npm run test:integration
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoClient, type Db } from 'mongodb'
import { PERMISSION_REGISTRY as P } from '../../src/common/permissions/registry.js'
import { listKnowledgeQuerySchema } from '../../src/modules/lumi/learning/domain/knowledge.types.js'
import { LumiKnowledgeRepository } from '../../src/modules/lumi/learning/infrastructure/lumi-knowledge.repository.js'
import { LumiLearningService } from '../../src/modules/lumi/learning/services/learning.service.js'
import { LUMI_TOOLS } from '../../src/modules/lumi/tools/catalog.js'
import { MongoTurnMetrics } from '../../src/modules/lumi/metrics/turn-metrics.js'

const uri = process.env.MONGO_TEST_URI
const describeIfDb = uri ? describe : describe.skip

describeIfDb('Lumi fase F: aprendizaje (MongoDB real)', () => {
  let client: MongoClient
  let db: Db
  let svc: LumiLearningService
  const ana = { userId: 'ana', permissionKeys: [P.LUMI_USE, P.ANALYTICS_READ, P.ORDERS_READ] }

  beforeAll(async () => {
    client = await new MongoClient(uri!).connect()
    db = client.db(`lumi_learning_it_${Date.now()}`)
    const repo = new LumiKnowledgeRepository(db)
    await repo.ensureIndexes()
    svc = new LumiLearningService(repo, {
      tools: LUMI_TOOLS,
      enabledTools: async () => new Set(LUMI_TOOLS.map((t) => t.name)),
      recordMissing: async () => ({ recorded: true }),
      timezone: 'America/Bogota',
    })
  })

  afterAll(async () => {
    await db?.dropDatabase()
    await client?.close()
  })

  it('aprende por usuario: otro usuario no lo ve hasta que un administrador lo hace global', async () => {
    const saved = await svc.recordFeedback(ana, { message: 'Lumi, lo de hoy', tool: 'sales.summary' })
    expect(saved.saved).toBe('interpretation')
    expect(await svc.learnedTool('ana', 'lo de hoy')).toMatchObject({ tool: 'sales.summary', scope: 'user' })
    expect(await svc.learnedTool('luis', 'lo de hoy')).toBeNull()
    const id = saved.saved === 'interpretation' ? saved.knowledge.id : ''
    await svc.promote(id, 'admin1')
    expect(await svc.learnedTool('luis', 'lo de hoy')).toMatchObject({ tool: 'sales.summary', scope: 'global' })
    const doc = await db.collection('lumi_knowledge').findOne({ scope: 'user' })
    expect(doc).toMatchObject({ uses: 1, phraseNorm: 'lo hoy' })
  })

  it('corrección por texto con «sí», con la última pregunta guardada con caducidad', async () => {
    await svc.rememberLastMessage('ana', 'lo pendiente de cobro')
    expect(await svc.handleTextTurn(ana, 'no, me refiero a pedidos pendientes')).toMatch(/^¿Guardo/)
    expect(await svc.handleTextTurn(ana, 'sí')).toMatch(/^Guardado/)
    expect(await svc.learnedTool('ana', 'lo pendiente de cobro')).toMatchObject({ tool: 'orders.count' })
    const ttl = (await db.collection('lumi_last_messages').indexes()).find((i) => i.name === 'lumi_last_messages_ttl')
    expect(ttl?.expireAfterSeconds).toBe(0)
  })

  it('el panel busca como texto literal y registra los eventos', async () => {
    expect((await svc.list(listKnowledgeQuerySchema.parse({ search: 'hoy' }))).pagination.total).toBe(2)
    expect((await svc.list(listKnowledgeQuerySchema.parse({ search: '.*' }))).items).toHaveLength(0)
    expect((await svc.list(listKnowledgeQuerySchema.parse({ scope: 'global' }))).items).toHaveLength(1)
    expect(await db.collection('lumi_knowledge_events').countDocuments()).toBeGreaterThanOrEqual(5)
  })

  it('métricas de turnos: contadores diarios con caducidad y sin texto', async () => {
    const metrics = new MongoTurnMetrics(db)
    await metrics.ensureIndexes()
    const at = new Date('2026-11-15T15:00:00.000Z')
    await metrics.record({ stage: 'rules', interpretation: 'supported' }, at)
    await metrics.record({ stage: 'selector', interpretation: 'missing_capability', selector: { outcome: 'ok', latencyMs: 6000, promptTokens: 1300, completionTokens: 40, examples: 1 } }, at)
    await metrics.record({ stage: 'fallback', interpretation: 'unsupported', selector: { outcome: 'error' } }, at)
    const summary = await metrics.summary(7, at)
    expect(summary).toMatchObject({ turns: 3, selectorCalls: 2, selectorErrors: 1, selectorLatencyMsAvg: 6000, selectorCallsWithExamples: 1 })
    expect(summary.withoutModelRate).toBeCloseTo(1 / 3)
    const doc = await db.collection('lumi_turn_metrics').findOne({ _id: '2026-11-15' as never })
    expect(Object.keys(doc ?? {}).sort()).toEqual(
      ['_id', 'expiresAt', 'interpretations', 'selectorCalls', 'selectorCallsWithExamples', 'selectorCompletionTokensTotal', 'selectorErrors', 'selectorLatencyMsTotal', 'selectorPromptTokensTotal', 'stages', 'turns'].sort(),
    )
  })
})

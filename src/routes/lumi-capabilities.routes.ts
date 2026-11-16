import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AppContext } from '../app.context.js'
import { AppError } from '../common/errors/app.error.js'
import { PERMISSION_REGISTRY } from '../common/permissions/registry.js'
import { adminGuard } from '../modules/admin/middleware/admin-guard.js'
import type { AuthenticatedRequest } from '../modules/identity/middleware/auth.middleware.js'
import {
  capabilityIdParamsSchema,
  changeCapabilityStatusSchema,
  listCapabilitiesQuerySchema,
  enableCapabilitySchema,
  mergeCapabilitySchema,
  updateCapabilitySchema,
} from '../modules/lumi/capabilities/domain/capability.types.js'
import {
  addPhraseSchema,
  phraseParamsSchema,
  runParamsSchema,
  startRunSchema,
  updatePhraseSchema,
} from '../modules/lumi/capabilities/domain/capability-test.types.js'
import { buildSpecDraftRequest, parseSpecDraft } from '../modules/lumi/capabilities/services/capability-spec-draft.js'
import { LumiAssistantClient } from '../modules/lumi/infrastructure/lumi-assistant.client.js'
import { LUMI_TOOLS } from '../modules/lumi/tools/catalog.js'

const turnMetricsQuerySchema = z.object({ days: z.coerce.number().int().refine((d) => [1, 7, 30].includes(d)).default(7) })

/**
 * Capability Manager de Lumi (fase B): lo que los usuarios piden y Lumi aún no sabe hacer.
 * Leer exige lumi.capabilities.read; especificar, priorizar, cambiar de estado o fusionar exige
 * lumi.capabilities.manage. Ninguna ruta crea ni habilita herramientas.
 */
export async function registerLumiCapabilityRoutes(api: FastifyInstance, ctx: AppContext) {
  const read = adminGuard(ctx.repos.sessions, PERMISSION_REGISTRY.LUMI_CAPABILITIES_READ, ctx.services.authorization)
  const manage = adminGuard(ctx.repos.sessions, PERMISSION_REGISTRY.LUMI_CAPABILITIES_MANAGE, ctx.services.authorization)
  const test = adminGuard(ctx.repos.sessions, PERMISSION_REGISTRY.LUMI_CAPABILITIES_TEST, ctx.services.authorization)
  const capabilities = ctx.services.lumiCapabilities
  const tests = ctx.services.lumiCapabilityTests
  const enableGuard = adminGuard(ctx.repos.sessions, PERMISSION_REGISTRY.LUMI_CAPABILITIES_ENABLE, ctx.services.authorization)
  const activation = ctx.services.lumiCapabilityActivation
  const base = '/admin/lumi/capabilities'
  const userIdOf = (request: unknown): string => (request as AuthenticatedRequest).auth.userId
  const keysOf = (request: unknown) => (request as AuthenticatedRequest).permissionKeys ?? []
  const assistant =
    ctx.env.LUMI_ASSISTANT_URL && ctx.env.LUMI_ASSISTANT_API_KEY
      ? new LumiAssistantClient({
          baseUrl: ctx.env.LUMI_ASSISTANT_URL.replace(/\/+$/, ''),
          apiKey: ctx.env.LUMI_ASSISTANT_API_KEY,
          timeoutMs: ctx.env.LUMI_ASSISTANT_TIMEOUT_MS,
        })
      : null

  const parse = <S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> => {
    const parsed = schema.safeParse(value)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error)
    return parsed.data
  }

  api.get(base, { preHandler: read }, async (request) => capabilities.list(parse(listCapabilitiesQuerySchema, request.query)))

  api.get(`${base}/stats`, { preHandler: read }, async () => capabilities.stats())

  // Fase G: cómo resuelve Lumi los turnos (contadores diarios, sin texto ni usuario).
  api.get(`${base}/metrics`, { preHandler: read }, async (request) => {
    const { days } = parse(turnMetricsQuerySchema, request.query)
    return ctx.services.lumiTurnMetrics.summary(days, new Date())
  })

  api.get(`${base}/:id`, { preHandler: read }, async (request) => {
    const { id } = parse(capabilityIdParamsSchema, request.params)
    return capabilities.get(id)
  })

  api.patch(`${base}/:id`, { preHandler: manage }, async (request) => {
    const { id } = parse(capabilityIdParamsSchema, request.params)
    return { capability: await capabilities.update(id, parse(updateCapabilitySchema, request.body), userIdOf(request)) }
  })

  api.post(`${base}/:id/status`, { preHandler: manage }, async (request) => {
    const { id } = parse(capabilityIdParamsSchema, request.params)
    const { status } = parse(changeCapabilityStatusSchema, request.body)
    return { capability: await capabilities.changeStatus(id, status, userIdOf(request)) }
  })

  // Borrador de especificación con IA. No guarda nada: el formulario lo muestra y se guarda con PATCH.
  api.post(`${base}/:id/spec-draft`, { preHandler: manage }, async (request) => {
    const { id } = parse(capabilityIdParamsSchema, request.params)
    if (!assistant) throw new AppError(503, 'El asistente Lumi no está configurado', 'LUMI_NOT_CONFIGURED')
    const { capability, recentRequests } = await capabilities.get(id)
    if (capability.status === 'duplicate') throw AppError.conflict('La capacidad está fusionada con otra')
    const plan = buildSpecDraftRequest(capability, recentRequests.map((r) => r.message), LUMI_TOOLS)
    const generated = await assistant.generate(userIdOf(request), plan.instructions, plan.input, plan.maxTokens)
    return { spec: parseSpecDraft(generated.text, LUMI_TOOLS), model: generated.model }
  })

  api.post(`${base}/:id/merge`, { preHandler: manage }, async (request) => {
    const { id } = parse(capabilityIdParamsSchema, request.params)
    const { targetId } = parse(mergeCapabilitySchema, request.body)
    return { capability: await capabilities.merge(id, targetId, userIdOf(request)) }
  })

  /* ───────────── Fase D: frases y pruebas ───────────── */

  api.get(`${base}/:id/phrases`, { preHandler: read }, async (request) => {
    const { id } = parse(capabilityIdParamsSchema, request.params)
    return { items: await tests.listPhrases(id) }
  })

  api.post(`${base}/:id/phrases`, { preHandler: manage }, async (request, reply) => {
    const { id } = parse(capabilityIdParamsSchema, request.params)
    const phrase = await tests.addPhrase(id, parse(addPhraseSchema, request.body), userIdOf(request))
    reply.code(201)
    return { phrase }
  })

  api.patch(`${base}/:id/phrases/:phraseId`, { preHandler: manage }, async (request) => {
    const { id, phraseId } = parse(phraseParamsSchema, request.params)
    return { phrase: await tests.updatePhrase(id, phraseId, parse(updatePhraseSchema, request.body)) }
  })

  api.delete(`${base}/:id/phrases/:phraseId`, { preHandler: manage }, async (request) => {
    const { id, phraseId } = parse(phraseParamsSchema, request.params)
    await tests.deletePhrase(id, phraseId)
    return { ok: true }
  })

  api.get(`${base}/:id/test-runs`, { preHandler: read }, async (request) => {
    const { id } = parse(capabilityIdParamsSchema, request.params)
    return { items: await tests.listRuns(id) }
  })

  api.get(`${base}/:id/test-runs/:runId`, { preHandler: read }, async (request) => {
    const { id, runId } = parse(runParamsSchema, request.params)
    return { run: await tests.getRun(id, runId) }
  })

  // Se ejecuta en segundo plano (una batería con el selector puede tardar minutos): 202 y se consulta.
  api.post(`${base}/:id/test-runs`, { preHandler: test }, async (request, reply) => {
    const { id } = parse(capabilityIdParamsSchema, request.params)
    const { run, completion } = await tests.startRun(id, parse(startRunSchema, request.body), {
      userId: userIdOf(request),
      permissionKeys: keysOf(request),
    })
    completion.catch((err) => request.log.error({ err }, 'Lumi capability test run failed'))
    reply.code(202)
    return { run }
  })

  /* ───────────── Fase E: activación ───────────── */

  // Requisitos para habilitar (sin la casilla de documentación, que se confirma al habilitar).
  api.get(`${base}/:id/enablement`, { preHandler: read }, async (request) => {
    const { id } = parse(capabilityIdParamsSchema, request.params)
    const { checks, canEnable } = await activation.checks(id)
    return { checks, canEnable }
  })

  api.post(`${base}/:id/enable`, { preHandler: enableGuard }, async (request) => {
    const { id } = parse(capabilityIdParamsSchema, request.params)
    parse(enableCapabilitySchema, request.body)
    return { capability: await activation.enable(id, userIdOf(request)) }
  })

  api.post(`${base}/:id/disable`, { preHandler: enableGuard }, async (request) => {
    const { id } = parse(capabilityIdParamsSchema, request.params)
    return { capability: await activation.disable(id, userIdOf(request)) }
  })
}

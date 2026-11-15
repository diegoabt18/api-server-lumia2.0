import type { FastifyInstance } from 'fastify'
import type { z } from 'zod'
import type { AppContext } from '../app.context.js'
import { AppError } from '../common/errors/app.error.js'
import { PERMISSION_REGISTRY } from '../common/permissions/registry.js'
import { adminGuard } from '../modules/admin/middleware/admin-guard.js'
import type { AuthenticatedRequest } from '../modules/identity/middleware/auth.middleware.js'
import {
  changeKnowledgeStatusSchema,
  feedbackSchema,
  knowledgeIdParamsSchema,
  listKnowledgeQuerySchema,
} from '../modules/lumi/learning/domain/knowledge.types.js'

/**
 * Learning Engine de Lumi (fase F).
 * - «No era esto»: cualquier usuario de Lumi (lumi.use), solo sobre sus propias interpretaciones y
 *   solo con herramientas que ya puede usar.
 * - Panel de aprendizaje: leer exige lumi.learning.read; aprobar, retirar, hacer global o borrar,
 *   lumi.learning.manage. Nada se vuelve global sin esa acción.
 */
export async function registerLumiLearningRoutes(api: FastifyInstance, ctx: AppContext) {
  const use = adminGuard(ctx.repos.sessions, PERMISSION_REGISTRY.LUMI_USE, ctx.services.authorization)
  const read = adminGuard(ctx.repos.sessions, PERMISSION_REGISTRY.LUMI_LEARNING_READ, ctx.services.authorization)
  const manage = adminGuard(ctx.repos.sessions, PERMISSION_REGISTRY.LUMI_LEARNING_MANAGE, ctx.services.authorization)
  const learning = ctx.services.lumiLearning
  const userIdOf = (request: unknown): string => (request as AuthenticatedRequest).auth.userId
  const keysOf = (request: unknown) => (request as AuthenticatedRequest).permissionKeys ?? []

  const parse = <S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> => {
    const parsed = schema.safeParse(value)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error)
    return parsed.data
  }

  api.get('/admin/lumi/feedback/options', { preHandler: use }, async (request) => ({
    items: await learning.feedbackOptions(keysOf(request)),
  }))

  api.post('/admin/lumi/feedback', { preHandler: use }, async (request) => {
    const input = parse(feedbackSchema, request.body)
    const result = await learning.recordFeedback({ userId: userIdOf(request), permissionKeys: keysOf(request) }, input)
    return result.saved === 'interpretation'
      ? { saved: 'interpretation', tool: result.knowledge.tool }
      : { saved: 'capability', registered: result.registered }
  })

  const base = '/admin/lumi/knowledge'

  api.get(base, { preHandler: read }, async (request) => learning.list(parse(listKnowledgeQuerySchema, request.query)))

  api.get(`${base}/:id`, { preHandler: read }, async (request) => {
    const { id } = parse(knowledgeIdParamsSchema, request.params)
    return learning.get(id)
  })

  api.post(`${base}/:id/status`, { preHandler: manage }, async (request) => {
    const { id } = parse(knowledgeIdParamsSchema, request.params)
    const { status } = parse(changeKnowledgeStatusSchema, request.body)
    return { knowledge: await learning.changeStatus(id, status, userIdOf(request)) }
  })

  api.post(`${base}/:id/promote`, { preHandler: manage }, async (request) => {
    const { id } = parse(knowledgeIdParamsSchema, request.params)
    return { knowledge: await learning.promote(id, userIdOf(request)) }
  })

  api.delete(`${base}/:id`, { preHandler: manage }, async (request) => {
    const { id } = parse(knowledgeIdParamsSchema, request.params)
    await learning.delete(id, userIdOf(request))
    return { ok: true }
  })
}

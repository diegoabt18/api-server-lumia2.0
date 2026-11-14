import type { FastifyInstance } from 'fastify'
import type { z } from 'zod'
import type { AppContext } from '../app.context.js'
import { AppError } from '../common/errors/app.error.js'
import { PERMISSION_REGISTRY } from '../common/permissions/registry.js'
import { adminGuard } from '../modules/admin/middleware/admin-guard.js'
import type { AuthenticatedRequest } from '../modules/identity/middleware/auth.middleware.js'
import {
  createRoutineSchema,
  createTaskSchema,
  listExecutionsQuerySchema,
  listTasksQuerySchema,
  taskIdParamsSchema,
  updateTaskSchema,
} from '../modules/lumi/automation/domain/automation.types.js'

/**
 * Centro de automatizaciones de Lumi (Fase 1). Solo expone operaciones estructuradas: el navegador
 * y el asistente nunca escriben en la base de datos del motor directamente.
 */
export async function registerLumiAutomationRoutes(api: FastifyInstance, ctx: AppContext) {
  const g = adminGuard(ctx.repos.sessions, PERMISSION_REGISTRY.LUMI_USE, ctx.services.authorization)
  const tasks = ctx.services.lumiTasks
  const base = '/admin/lumi/automation'
  const userIdOf = (request: unknown): string => (request as AuthenticatedRequest).auth.userId

  const parse = <S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> => {
    const parsed = schema.safeParse(value)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error)
    return parsed.data
  }

  api.get(`${base}/tasks`, { preHandler: g }, async (request) => {
    const query = parse(listTasksQuerySchema, request.query)
    return { items: await tasks.list(userIdOf(request), query.status) }
  })

  api.post(`${base}/tasks`, { preHandler: g }, async (request) => {
    const body = parse(createTaskSchema, request.body)
    return tasks.create(userIdOf(request), body)
  })

  /** Rutina diaria con segundo aviso opcional. Mismo flujo que la orden por chat. */
  api.post(`${base}/routines`, { preHandler: g }, async (request) => {
    const body = parse(createRoutineSchema, request.body)
    return tasks.createRoutine(userIdOf(request), {
      ...body,
      description: body.description ?? null,
      followUpTime: body.followUpTime ?? null,
    })
  })

  api.patch(`${base}/tasks/:id`, { preHandler: g }, async (request) => {
    const { id } = parse(taskIdParamsSchema, request.params)
    const body = parse(updateTaskSchema, request.body)
    return tasks.update(userIdOf(request), id, body)
  })

  for (const action of ['pause', 'resume', 'complete'] as const) {
    api.post(`${base}/tasks/:id/${action}`, { preHandler: g }, async (request) => {
      const { id } = parse(taskIdParamsSchema, request.params)
      return tasks[action](userIdOf(request), id)
    })
  }

  api.delete(`${base}/tasks/:id`, { preHandler: g }, async (request) => {
    const { id } = parse(taskIdParamsSchema, request.params)
    await tasks.remove(userIdOf(request), id)
    return { ok: true }
  })

  /** Acción "Marcar como revisado" desde una notificación: confirma la revisión y marca la notificación. */
  api.post(`${base}/notifications/:id/review`, { preHandler: g }, async (request) => {
    const { id } = parse(taskIdParamsSchema, request.params)
    const userId = userIdOf(request)
    const notification = await ctx.repos.notifications.findOwned(userId, id)
    if (!notification) throw AppError.notFound('Notificación no encontrada')
    const taskId = notification.data?.taskId
    if (!taskId) throw AppError.badRequest('La notificación no está asociada a una rutina')
    const confirmed = await ctx.services.lumiCommands.confirmReview(userId, taskId)
    if (!confirmed) throw AppError.notFound('La rutina ya no existe')
    await ctx.repos.notifications.markReviewed(userId, [id])
    return { ok: true, reviewed: true }
  })

  api.get(`${base}/executions`, { preHandler: g }, async (request) => {
    const query = parse(listExecutionsQuerySchema, request.query)
    return {
      items: await tasks.listExecutions(userIdOf(request), query.taskId, query.limit),
    }
  })
}

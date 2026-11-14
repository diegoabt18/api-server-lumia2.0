import type { FastifyInstance } from 'fastify'
import type { z } from 'zod'
import type { AppContext } from '../app.context.js'
import { AppError } from '../common/errors/app.error.js'
import { PERMISSION_REGISTRY } from '../common/permissions/registry.js'
import { adminGuard } from '../modules/admin/middleware/admin-guard.js'
import type { AuthenticatedRequest } from '../modules/identity/middleware/auth.middleware.js'
import {
  changeInitiativeStateSchema,
  initiativeIdParamsSchema,
  initiativeSettingsSchema,
  listInitiativesQuerySchema,
} from '../modules/lumi/initiatives/domain/initiative.types.js'

/**
 * Iniciativas de Lumi (Fase 4). Solo lectura de propuestas y decisiones de estado; Lumi no ejecuta
 * acciones sobre la tienda desde aquí.
 */
export async function registerLumiInitiativeRoutes(api: FastifyInstance, ctx: AppContext) {
  const g = adminGuard(ctx.repos.sessions, PERMISSION_REGISTRY.LUMI_USE, ctx.services.authorization)
  const initiatives = ctx.services.lumiInitiatives
  const base = '/admin/lumi/initiatives'
  const userIdOf = (request: unknown): string => (request as AuthenticatedRequest).auth.userId

  const parse = <S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> => {
    const parsed = schema.safeParse(value)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error)
    return parsed.data
  }

  api.get(base, { preHandler: g }, async (request) => {
    const query = parse(listInitiativesQuerySchema, request.query)
    return { items: await initiatives.list(userIdOf(request), { state: query.state, limit: query.limit }) }
  })

  api.get(`${base}/settings`, { preHandler: g }, async (request) => ({
    level: await initiatives.getLevel(userIdOf(request)),
  }))

  api.put(`${base}/settings`, { preHandler: g }, async (request) => {
    const body = parse(initiativeSettingsSchema, request.body)
    await initiatives.setLevel(userIdOf(request), body.level)
    return { ok: true, level: body.level }
  })

  api.post(`${base}/:id/state`, { preHandler: g }, async (request) => {
    const { id } = parse(initiativeIdParamsSchema, request.params)
    const body = parse(changeInitiativeStateSchema, request.body)
    return initiatives.changeState(userIdOf(request), id, body.state)
  })
}

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AppContext } from '../app.context.js'
import { AppError } from '../common/errors/app.error.js'
import { PERMISSION_REGISTRY } from '../common/permissions/registry.js'
import { adminGuard } from '../modules/admin/middleware/admin-guard.js'

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  actorUserId: z.string().regex(/^[a-f0-9]{24}$/i).optional(),
  resourceType: z.string().trim().max(60).optional(),
  resourceId: z.string().trim().max(120).optional(),
  result: z.enum(['success', 'denied', 'failure']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
})

/**
 * Consulta de la actividad administrativa. Solo lectura: el registro no tiene rutas para
 * modificar ni borrar. `verify` recorre la cadena HMAC y señala el primer registro alterado.
 */
export async function registerAdminActivityRoutes(api: FastifyInstance, ctx: AppContext) {
  const read = adminGuard(ctx.repos.sessions, PERMISSION_REGISTRY.ADMIN_AUDIT_READ, ctx.services.authorization)

  api.get('/admin/activity-audit', { preHandler: read }, async (request) => {
    const parsed = listQuerySchema.safeParse(request.query)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    const { items, total } = await ctx.activityAudit.list(parsed.data)
    return {
      items: items.map((r) => ({ ...r, at: r.at.toISOString() })),
      total,
      page: parsed.data.page,
      limit: parsed.data.limit,
    }
  })

  api.get('/admin/activity-audit/verify', { preHandler: read }, async () => ctx.activityAudit.verify())
}

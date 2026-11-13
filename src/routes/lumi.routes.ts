import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { AppContext } from '../app.context.js'
import { AppError } from '../common/errors/app.error.js'
import { PERMISSION_REGISTRY, hasPermission } from '../common/permissions/registry.js'
import { adminGuard } from '../modules/admin/middleware/admin-guard.js'
import type { AuthenticatedRequest } from '../modules/identity/middleware/auth.middleware.js'
import {
  LumiAssistantClient,
  type LumiStreamEvent,
} from '../modules/lumi/infrastructure/lumi-assistant.client.js'
import {
  buildAssistRequest,
  lumiProductAssistSchema,
  sanitizeSuggestion,
} from '../modules/lumi/services/lumi-product-assist.js'
import {
  type LumiContextInput,
  summarizeAnalyticsContext,
  summarizeDashboardContext,
  summarizeOrderContext,
  summarizePageContext,
  summarizeProductContext,
} from '../modules/lumi/services/lumi-context.js'
import {
  lumiChatBodySchema,
  lumiConversationParamsSchema,
  lumiListQuerySchema,
  lumiProductParamsSchema,
  lumiUsageQuerySchema,
} from '../modules/lumi/schemas/lumi.schema.js'

/**
 * Asistente Lumi para administradores. El servidor autoriza (admin.access + lumi.use),
 * identifica al usuario y reenvía la petición a ia-asistente con su identificador.
 * El navegador nunca recibe la URL ni la clave de ia-asistente.
 */
export async function registerLumiRoutes(api: FastifyInstance, ctx: AppContext) {
  const { env } = ctx
  const g = (permission: (typeof PERMISSION_REGISTRY)[keyof typeof PERMISSION_REGISTRY]) =>
    adminGuard(ctx.repos.sessions, permission, ctx.services.authorization)

  const client =
    env.LUMI_ASSISTANT_URL && env.LUMI_ASSISTANT_API_KEY
      ? new LumiAssistantClient({
          baseUrl: env.LUMI_ASSISTANT_URL.replace(/\/+$/, ''),
          apiKey: env.LUMI_ASSISTANT_API_KEY,
          timeoutMs: env.LUMI_ASSISTANT_TIMEOUT_MS,
        })
      : null

  const requireClient = (): LumiAssistantClient => {
    if (!client)
      throw new AppError(503, 'El asistente Lumi no está configurado', 'LUMI_NOT_CONFIGURED')
    return client
  }

  const userIdOf = (request: unknown): string => (request as AuthenticatedRequest).auth.userId

  /**
   * Resumen del contexto de pantalla. Solo se lee lo que el usuario puede ver: sin el permiso
   * correspondiente la petición se rechaza en lugar de enviar datos al modelo.
   */
  const buildContext = async (
    request: FastifyRequest,
    input: LumiContextInput | undefined,
  ): Promise<string | undefined> => {
    if (!input) return undefined
    const keys = (request as AuthenticatedRequest).permissionKeys
    if (input.kind === 'page') {
      // Sin permiso para el módulo, Lumi solo recibe el nombre de la vista (nunca cifras).
      if (input.page === 'dashboard' && hasPermission(keys, PERMISSION_REGISTRY.ADMIN_ACCESS)) {
        return summarizeDashboardContext(await ctx.services.adminDashboard.getStats())
      }
      if (input.page === 'analytics' && hasPermission(keys, PERMISSION_REGISTRY.ANALYTICS_READ)) {
        // Analítica usa 30 días por defecto: el periodo elegido en pantalla todavía no se envía.
        return summarizeAnalyticsContext(
          await ctx.services.adminAnalytics.getOverview({ period: '30d' }),
        )
      }
      return summarizePageContext(input.page)
    }
    if (input.kind === 'product') {
      if (!hasPermission(keys, PERMISSION_REGISTRY.PRODUCTS_READ)) {
        throw AppError.forbidden('Sin permiso para ver este producto')
      }
      return summarizeProductContext(await ctx.services.adminProducts.get(input.id))
    }
    if (!hasPermission(keys, PERMISSION_REGISTRY.ORDERS_READ)) {
      throw AppError.forbidden('Sin permiso para ver este pedido')
    }
    return summarizeOrderContext(await ctx.services.adminOrders.get(input.id))
  }

  /**
   * Turno de chat. En modo búsqueda web (lumi.web) solo viaja la pregunta: no se lee ningún dato
   * de la API ni se envía contexto de pantalla, y la búsqueda sale a internet a través de ia-asistente.
   */
  const chatTurn = async (
    request: FastifyRequest,
    body: { context?: LumiContextInput; webSearch: boolean },
  ): Promise<{ context: string | undefined; useWeb: boolean }> => {
    if (!body.webSearch) return { context: await buildContext(request, body.context), useWeb: false }
    const keys = (request as AuthenticatedRequest).permissionKeys
    if (!hasPermission(keys, PERMISSION_REGISTRY.LUMI_WEB)) {
      throw AppError.forbidden('Sin permiso para la búsqueda web de Lumi')
    }
    return { context: undefined, useWeb: true }
  }

  api.post('/admin/lumi/chat', { preHandler: g(PERMISSION_REGISTRY.LUMI_USE) }, async (request) => {
    const parsed = lumiChatBodySchema.safeParse(request.body)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    const turn = await chatTurn(request, parsed.data)
    const result = await requireClient().chat(
      userIdOf(request),
      parsed.data.message,
      parsed.data.conversationId,
      turn.context,
      turn.useWeb,
    )
    return {
      conversationId: result.conversationId,
      model: result.model,
      response: result.response,
    }
  })

  /**
   * Chat en streaming (SSE). El primer evento se espera antes de enviar cabeceras: así los
   * errores previos (conversación inexistente, asistente caído) siguen siendo respuestas JSON.
   * Si el navegador se desconecta, se aborta la llamada a ia-asistente y no se guarda el turno.
   */
  api.post(
    '/admin/lumi/chat/stream',
    { preHandler: g(PERMISSION_REGISTRY.LUMI_USE) },
    async (request, reply) => {
      const parsed = lumiChatBodySchema.safeParse(request.body)
      if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())

      const turn = await chatTurn(request, parsed.data)
      const controller = new AbortController()
      const events = requireClient()
        .chatStream(
          userIdOf(request),
          parsed.data.message,
          parsed.data.conversationId,
          controller.signal,
          turn.context,
          turn.useWeb,
        )
        [Symbol.asyncIterator]()

      let current = await events.next()

      reply.hijack()
      const raw = reply.raw
      raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      const onClose = () => controller.abort()
      raw.once('close', onClose)

      const write = (event: LumiStreamEvent) => {
        const { type, ...payload } = event
        raw.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`)
      }

      try {
        while (!current.done) {
          write(current.value)
          current = await events.next()
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          request.log.warn({ err: error }, 'Lumi stream interrupted')
          write({ type: 'error', message: 'El asistente Lumi no pudo completar la respuesta.' })
        }
      } finally {
        raw.off('close', onClose)
        raw.end()
      }
    },
  )

  /**
   * Sugerencia de contenido para un producto (título, descripción, SEO, ortografía, tono).
   * Requiere lumi.use y products.read. No guarda nada: la sugerencia se aplica en el formulario.
   */
  api.post(
    '/admin/lumi/products/:id/assist',
    { preHandler: g(PERMISSION_REGISTRY.LUMI_USE) },
    async (request) => {
      const params = lumiProductParamsSchema.safeParse(request.params)
      if (!params.success) throw AppError.badRequest('Invalid input', params.error.flatten())
      const parsed = lumiProductAssistSchema.safeParse(request.body)
      if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
      const keys = (request as AuthenticatedRequest).permissionKeys
      if (!hasPermission(keys, PERMISSION_REGISTRY.PRODUCTS_READ)) {
        throw AppError.forbidden('Sin permiso para ver este producto')
      }
      const product = await ctx.services.adminProducts.get(params.data.id)
      const plan = buildAssistRequest(parsed.data, product)
      const generated = await requireClient().generate(
        userIdOf(request),
        plan.instructions,
        plan.input,
        plan.maxTokens,
      )
      return {
        action: parsed.data.action,
        text: sanitizeSuggestion(parsed.data.action, generated.text),
      }
    },
  )

  api.get(
    '/admin/lumi/conversations',
    { preHandler: g(PERMISSION_REGISTRY.LUMI_USE) },
    async (request) => {
      const parsed = lumiListQuerySchema.safeParse(request.query)
      if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
      return requireClient().listConversations(
        userIdOf(request),
        parsed.data.limit,
        parsed.data.offset,
      )
    },
  )

  api.get(
    '/admin/lumi/conversations/:id',
    { preHandler: g(PERMISSION_REGISTRY.LUMI_USE) },
    async (request) => {
      const parsed = lumiConversationParamsSchema.safeParse(request.params)
      if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
      return requireClient().getConversation(userIdOf(request), parsed.data.id)
    },
  )

  api.delete(
    '/admin/lumi/conversations/:id',
    { preHandler: g(PERMISSION_REGISTRY.LUMI_USE) },
    async (request) => {
      const parsed = lumiConversationParamsSchema.safeParse(request.params)
      if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
      await requireClient().deleteConversation(userIdOf(request), parsed.data.id)
      return { ok: true }
    },
  )

  api.get('/admin/lumi/usage', { preHandler: g(PERMISSION_REGISTRY.LUMI_USE) }, async (request) => {
    const parsed = lumiUsageQuerySchema.safeParse(request.query)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    return requireClient().usage(userIdOf(request), parsed.data.days)
  })
}

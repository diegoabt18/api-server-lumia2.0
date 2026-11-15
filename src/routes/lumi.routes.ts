import { randomUUID } from 'node:crypto'
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
import { type LumiMode, resolveLumiModes } from '../modules/lumi/services/lumi-intent-router.js'
import { DEFAULT_AUTOMATION_TIMEZONE } from '../modules/lumi/automation/domain/schedule.js'
import { capabilitiesFor, matchTool, runTool, type ToolMatch } from '../modules/lumi/tools/catalog.js'
import type { LumiEntityRef } from '../modules/lumi/tools/tool.types.js'
import { entityContextLine } from '../modules/lumi/selector/active-entity.js'
import {
  AMBIGUOUS_REPLY,
  interpret,
  missingCapabilityReply,
  normalizeProposal,
  REMINDER_HINT,
  selectorCatalog,
} from '../modules/lumi/selector/lumi-selector.js'
import { createLumiToolDeps } from '../modules/lumi/tools/tool-adapters.js'
import {
  buildAssistRequest,
  lumiProductAssistSchema,
  sanitizeSuggestion,
} from '../modules/lumi/services/lumi-product-assist.js'
import {
  LUMI_CONTEXT_MAX_CHARS,
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
   * Guarda en el historial un turno resuelto por reglas (recordatorios), sin llamar al modelo, y
   * devuelve el id de la conversación. Sin asistente configurado no hay historial que guardar.
   */
  const saveAutomatedTurn = async (
    request: FastifyRequest,
    message: string,
    answer: string,
    conversationId: string | undefined,
  ): Promise<string> => {
    if (!client) return conversationId ?? randomUUID()
    try {
      return (await client.recordExchange(userIdOf(request), message, answer, conversationId)).conversationId
    } catch (err) {
      request.log.warn({ err }, 'Lumi automated turn not saved')
      return conversationId ?? randomUUID()
    }
  }

  const keysOf = (request: unknown) => (request as AuthenticatedRequest).permissionKeys ?? []
  const timezone = DEFAULT_AUTOMATION_TIMEZONE
  const toolDeps = createLumiToolDeps({
    orders: ctx.repos.orders,
    products: ctx.repos.products,
    notifications: ctx.repos.notifications,
    initiatives: ctx.services.lumiInitiatives,
  })

  /** Herramienta del catálogo reconocida por reglas (consultas de datos reales, sin modelo). */
  const findTool = (request: FastifyRequest, message: string): ToolMatch | null =>
    matchTool(message, keysOf(request), { now: new Date(), timezone })

  const executeTool = (request: FastifyRequest, match: ToolMatch) =>
    runTool(match, {
      userId: userIdOf(request),
      permissionKeys: keysOf(request),
      now: new Date(),
      timezone,
      deps: toolDeps,
    })

  const toolEvent = (match: ToolMatch, rows: number): LumiStreamEvent => ({
    type: 'tool',
    name: match.tool.name,
    label: match.tool.label,
    rows,
    denied: match.denied,
  })

  /**
   * Turno resuelto por una herramienta: la respuesta son los datos leídos, con texto determinista.
   * No llama al modelo. El turno se guarda en el historial igual que uno del modelo.
   */
  async function* toolTurnStream(
    request: FastifyRequest,
    matches: ToolMatch[],
    message: string,
    conversationId: string | undefined,
  ): AsyncGenerator<LumiStreamEvent> {
    const texts: string[] = []
    let entity: LumiEntityRef | undefined
    for (const match of matches) {
      const result = await executeTool(request, match)
      yield toolEvent(match, result.rows)
      texts.push(result.text)
      entity = result.entity ?? entity
    }
    const text = texts.join('\n\n')
    const saved = await requireClient().recordExchange(userIdOf(request), message, text, conversationId)
    // Context Manager: la entidad de la respuesta queda activa para el turno siguiente.
    if (entity) {
      await ctx.services.lumiActiveEntities
        .set(userIdOf(request), saved.conversationId, entity, new Date())
        .catch((err) => request.log.warn({ err }, 'Lumi active entity not saved'))
    }
    yield { type: 'token', text }
    yield { type: 'done', conversationId: saved.conversationId }
  }

  /**
   * Entidad activa del turno: la que el usuario tiene abierta en pantalla (con su permiso) o, si
   * no, la última de la conversación mientras no caduque. Nunca falla el turno por esto.
   */
  const activeEntity = async (
    request: FastifyRequest,
    conversationId: string | undefined,
    input: LumiContextInput | undefined,
    now: Date,
  ): Promise<LumiEntityRef | null> => {
    const keys = keysOf(request)
    try {
      if (input?.kind === 'order' && hasPermission([...keys], PERMISSION_REGISTRY.ORDERS_READ)) {
        const { order } = await ctx.services.adminOrders.get(input.id)
        return order.orderNumber ? { kind: 'order', label: order.orderNumber } : null
      }
      if (input?.kind === 'product' && hasPermission([...keys], PERMISSION_REGISTRY.PRODUCTS_READ)) {
        const { product } = await ctx.services.adminProducts.get(input.id)
        return { kind: 'product', label: product.name }
      }
      return conversationId ? await ctx.services.lumiActiveEntities.get(userIdOf(request), conversationId, now) : null
    } catch (err) {
      request.log.warn({ err }, 'Lumi active entity unavailable')
      return null
    }
  }

  type TurnPlan =
    /** Datos de la tienda con texto determinista, sin conversación con el modelo. */
    | { kind: 'tools'; matches: ToolMatch[] }
    /** Respuesta fija del Server: falta un dato, falta la capacidad o no se entiende. */
    | { kind: 'reply'; text: string }
    /** Conversación con el modelo; con `match`, los datos de esa herramienta van como contexto. */
    | { kind: 'model'; match: ToolMatch | null; forceWeb: boolean }

  /**
   * Intent Engine de Lumi en tres etapas: reglas (sin modelo) → selector con Qwen (propone) →
   * Server (valida, completa, comprueba permisos y decide). Si el selector está desactivado o no
   * responde, el turno sigue como antes: conversación.
   */
  const planTurn = async (
    request: FastifyRequest,
    message: string,
    conversationId: string | undefined,
    contextInput: LumiContextInput | undefined,
  ): Promise<TurnPlan> => {
    const match = findTool(request, message)
    if (match) return match.explain && !match.denied ? { kind: 'model', match, forceWeb: false } : { kind: 'tools', matches: [match] }
    if (!env.LUMI_SELECTOR_ENABLED || !client) return { kind: 'model', match: null, forceWeb: false }

    const now = new Date()
    const entity = await activeEntity(request, conversationId, contextInput, now)
    let proposal
    try {
      proposal = await client.select(
        userIdOf(request),
        { message, context: entityContextLine(entity), ...selectorCatalog() },
        env.LUMI_SELECTOR_TIMEOUT_MS,
      )
    } catch (err) {
      request.log.warn({ err }, 'Lumi selector unavailable; falling back to chat')
      return { kind: 'model', match: null, forceWeb: false }
    }
    const normalized = normalizeProposal(message, proposal, entity)
    const result = interpret(message, normalized, keysOf(request), { now, timezone })
    // Métricas del selector sin el texto del usuario.
    request.log.info(
      {
        lumiSelector: {
          proposed: proposal.status,
          final: result.status,
          tools: normalized.intents.map((i) => i.tool),
          module: normalized.module,
          latencyMs: proposal.latencyMs,
          promptTokens: proposal.promptTokens,
          completionTokens: proposal.completionTokens,
          parseErrors: proposal.errors.length,
        },
      },
      'Lumi selector',
    )
    switch (result.status) {
      case 'supported': {
        const only = result.matches.length === 1 ? result.matches[0]! : null
        return only && only.explain && !only.denied
          ? { kind: 'model', match: only, forceWeb: false }
          : { kind: 'tools', matches: result.matches }
      }
      case 'delegated':
        return result.delegate === 'reminder'
          ? { kind: 'reply', text: REMINDER_HINT }
          : { kind: 'model', match: null, forceWeb: result.delegate === 'web' }
      case 'missing_information':
        return { kind: 'reply', text: result.ask }
      case 'missing_capability':
        return { kind: 'reply', text: missingCapabilityReply(result.need) }
      case 'ambiguous':
        return { kind: 'reply', text: AMBIGUOUS_REPLY }
      case 'unsupported':
        return { kind: 'model', match: null, forceWeb: false }
    }
  }

  /**
   * "¿Por qué bajaron las ventas esta semana?": la herramienta lee los datos y el modelo los explica.
   * Los datos viajan como contexto (rotulado como datos), nunca como instrucciones.
   */
  const toolDataContext = (match: ToolMatch, text: string): string => {
    const body = `Datos consultados por el sistema (${match.tool.label.toLowerCase()}):\n${text}`
    return body.length > LUMI_CONTEXT_MAX_CHARS ? `${body.slice(0, LUMI_CONTEXT_MAX_CHARS - 1)}…` : body
  }

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
   * Controles del turno (razonamiento y búsqueda web) y contexto de pantalla. En búsqueda web solo
   * viaja la pregunta: no se lee ningún dato de la API y la búsqueda sale a internet vía ia-asistente.
   * Los campos antiguos (`think`, `webSearch`) siguen aceptándose si llegan sin los nuevos.
   */
  const resolveTurn = async (
    request: FastifyRequest,
    body: {
      message: string
      context?: LumiContextInput
      think?: boolean
      webSearch?: boolean
      reasoningMode?: LumiMode
      webMode?: LumiMode
    },
    forceWeb = false,
  ): Promise<{ context: string | undefined; webSearch: boolean; reasoning: boolean; capabilities: string }> => {
    const keys = (request as AuthenticatedRequest).permissionKeys
    const capabilities = capabilitiesFor(keys, new Date(), timezone)
    const canWeb = hasPermission(keys, PERMISSION_REGISTRY.LUMI_WEB)
    const webMode = body.webMode ?? (body.webSearch === undefined ? 'auto' : body.webSearch ? 'on' : 'off')
    const modes = resolveLumiModes({
      message: body.message,
      reasoningMode:
        body.reasoningMode ?? (body.think === undefined ? 'auto' : body.think ? 'on' : 'off'),
      // El selector reconoció clima o investigación: en modo automático se activa la búsqueda web.
      webMode: forceWeb && webMode === 'auto' && canWeb ? 'on' : webMode,
      canWeb,
    })
    if (modes.webDenied) throw AppError.forbidden('Sin permiso para la búsqueda web de Lumi')
    if (modes.webSearch) return { context: undefined, webSearch: true, reasoning: modes.reasoning, capabilities }
    return {
      context: await buildContext(request, body.context),
      webSearch: false,
      reasoning: modes.reasoning,
      capabilities,
    }
  }

  api.post('/admin/lumi/chat', { preHandler: g(PERMISSION_REGISTRY.LUMI_USE) }, async (request) => {
    const parsed = lumiChatBodySchema.safeParse(request.body)
    if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
    // Órdenes de recordatorio: se resuelven con reglas y el backend, sin llamar al modelo.
    const automated = await ctx.services.lumiCommands.handle(userIdOf(request), parsed.data.message)
    if (automated !== null) {
      return {
        conversationId: await saveAutomatedTurn(request, parsed.data.message, automated, parsed.data.conversationId),
        model: 'lumi-automation',
        response: automated,
      }
    }
    // Mismo plan que el streaming: lo que resuelve una herramienta del backend no usa el modelo.
    const plan = await planTurn(request, parsed.data.message, parsed.data.conversationId, parsed.data.context)
    if (plan.kind === 'reply') {
      return {
        conversationId: await saveAutomatedTurn(request, parsed.data.message, plan.text, parsed.data.conversationId),
        model: 'lumi-selector',
        response: plan.text,
      }
    }
    if (plan.kind === 'tools') {
      let response = ''
      let conversationId = parsed.data.conversationId ?? ''
      let tool: { name: string; rows: number } | null = null
      for await (const event of toolTurnStream(request, plan.matches, parsed.data.message, parsed.data.conversationId)) {
        if (event.type === 'tool') tool ??= { name: event.name, rows: event.rows }
        if (event.type === 'token') response += event.text
        if (event.type === 'done') conversationId = event.conversationId
      }
      return { conversationId, model: 'lumi-tools', response, tool }
    }
    const match = plan.match
    const turn = await resolveTurn(request, parsed.data, plan.forceWeb)
    // Petición de explicación sobre datos: la herramienta los lee y sustituyen al contexto de pantalla.
    const toolResult = match ? await executeTool(request, match) : null
    const result = await requireClient().chat(
      userIdOf(request),
      parsed.data.message,
      parsed.data.conversationId,
      match && toolResult ? toolDataContext(match, toolResult.text) : turn.context,
      match ? false : turn.webSearch,
      { think: turn.reasoning, maxTokens: parsed.data.maxTokens, capabilities: turn.capabilities },
    )
    return {
      conversationId: result.conversationId,
      model: result.model,
      response: result.response,
      tool: match && toolResult ? { name: match.tool.name, rows: toolResult.rows } : null,
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

      const automated = await ctx.services.lumiCommands.handle(userIdOf(request), parsed.data.message)
      const plan =
        automated === null
          ? await planTurn(request, parsed.data.message, parsed.data.conversationId, parsed.data.context)
          : null
      // Respuesta sin modelo: recordatorio resuelto por reglas o respuesta fija del selector.
      const fixed = automated ?? (plan?.kind === 'reply' ? plan.text : null)
      if (fixed !== null) {
        const conversationId = await saveAutomatedTurn(
          request,
          parsed.data.message,
          fixed,
          parsed.data.conversationId,
        )
        reply.hijack()
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        })
        reply.raw.write(`event: token\ndata: ${JSON.stringify({ text: fixed })}\n\n`)
        reply.raw.write(
          `event: done\ndata: ${JSON.stringify({ conversationId })}\n\n`,
        )
        reply.raw.end()
        return
      }

      const controller = new AbortController()
      // Las reglas resuelven lo claro sin modelo. La búsqueda web no cambia esto: los pedidos o las
      // ventas son datos de la tienda, no una consulta a internet.
      const toolMatches = plan?.kind === 'tools' ? plan.matches : null
      const match = plan?.kind === 'model' ? plan.match : null
      const turn = toolMatches ? null : await resolveTurn(request, parsed.data, plan?.kind === 'model' && plan.forceWeb)
      // Explicación sobre datos: primero la herramienta (datos reales), después el modelo los explica.
      const toolResult = match && turn ? await executeTool(request, match) : null
      const preface: LumiStreamEvent[] = match && toolResult ? [toolEvent(match, toolResult.rows)] : []
      const events = (
        toolMatches || !turn
          ? toolTurnStream(request, toolMatches ?? [], parsed.data.message, parsed.data.conversationId)
          : requireClient().chatStream(
              userIdOf(request),
              parsed.data.message,
              parsed.data.conversationId,
              controller.signal,
              match && toolResult ? toolDataContext(match, toolResult.text) : turn.context,
              match ? false : turn.webSearch,
              { think: turn.reasoning, maxTokens: parsed.data.maxTokens, capabilities: turn.capabilities },
            )
      )[Symbol.asyncIterator]()

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

      // Informa qué modo se usó y qué datos se consultaron, para que el chat lo muestre.
      if (turn) {
        write({ type: 'mode', webSearch: match ? false : turn.webSearch, reasoning: turn.reasoning })
      }
      for (const event of preface) write(event)

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

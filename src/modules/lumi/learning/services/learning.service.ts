import { AppError } from '../../../../common/errors/app.error.js'
import { buildPaginationMeta } from '../../../../common/utils/pagination.js'
import type { PermissionId } from '../../../../common/permissions/registry.js'
import { parseAutomationCommand } from '../../automation/domain/reminder-parser.js'
import { canUseTool, isToolEnabled, matchTool } from '../../tools/catalog.js'
import type { LumiTool } from '../../tools/tool.types.js'
import type { KnowledgeStore } from '../domain/knowledge.store.js'
import {
  ADMIN_TRANSITIONS,
  confirmationAnswer,
  CONFIRMATION_WINDOW_MS,
  correctionTarget,
  EXAMPLE_MIN_SIMILARITY,
  EXAMPLES_LIMIT,
  LAST_MESSAGE_TTL_MS,
  normalizePhrase,
  PHRASE_MAX_CHARS,
  phraseSimilarity,
  USER_KNOWLEDGE_LIMIT,
  type FeedbackInput,
  type KnowledgeStatus,
  type ListKnowledgeQuery,
  type LumiKnowledge,
} from '../domain/knowledge.types.js'

export interface Learner {
  userId: string
  permissionKeys: readonly PermissionId[]
}

export interface LearningDeps {
  /** Registro de herramientas del Server (LUMI_TOOLS). */
  tools: ReadonlyArray<LumiTool<never>>
  /** Puerta de habilitación (fase E). */
  enabledTools: () => Promise<ReadonlySet<string>>
  /** Registrar una capacidad que falta (fase B). */
  recordMissing: (input: { userId: string; conversationId: string | null; message: string; need: string; module: string }) => Promise<{ recorded: boolean }>
  timezone: string
}

export interface LearnedMatch {
  knowledgeId: string
  tool: string
  scope: LumiKnowledge['scope']
}

const clean = (v: string) => v.replace(/\s+/g, ' ').trim().slice(0, PHRASE_MAX_CHARS)

/**
 * Learning Engine (fase F). Aprende «frase → herramienta» solo por acciones explícitas del usuario
 * (el botón «No era esto» o una corrección por texto confirmada con «sí») o de un administrador.
 * Nada se aprende solo, nada se vuelve global sin un administrador y nada concede permisos.
 */
export class LumiLearningService {
  constructor(
    private readonly store: KnowledgeStore,
    private readonly deps: LearningDeps,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /* ───────────── Chat ───────────── */

  /**
   * Interpretación aprobada para esta frase exacta (normalizada): la del usuario primero; si no, una
   * global sin contradicciones. Solo herramientas que existen y están habilitadas.
   */
  async learnedTool(userId: string, message: string, enabled?: ReadonlySet<string>, track = true): Promise<LearnedMatch | null> {
    const norm = normalizePhrase(message)
    if (!norm) return null
    const usable = (await this.store.findApproved(userId, norm)).filter((k) => {
      const tool = this.deps.tools.find((t) => t.name === k.tool)
      return tool && isToolEnabled(tool, enabled)
    })
    const own = usable.find((k) => k.scope === 'user')
    const globals = usable.filter((k) => k.scope === 'global')
    const pick = own ?? (new Set(globals.map((g) => g.tool)).size === 1 ? globals[0] : undefined)
    if (!pick) return null
    // `track: false` en el entorno de pruebas: probar no cuenta como uso.
    if (track) await this.store.markUsed(pick.id, this.clock()).catch(() => undefined)
    return { knowledgeId: pick.id, tool: pick.tool, scope: pick.scope }
  }

  /** Hasta 3 interpretaciones aprobadas parecidas, como ejemplos para el selector (no reentrena nada). */
  async examples(userId: string, message: string, enabled?: ReadonlySet<string>): Promise<Array<{ message: string; tool: string; args: Record<string, unknown> }>> {
    const norm = normalizePhrase(message)
    if (!norm) return []
    const scored = (await this.store.listApprovedFor(userId, 200))
      .filter((k) => {
        const tool = this.deps.tools.find((t) => t.name === k.tool)
        return tool?.selector && isToolEnabled(tool, enabled)
      })
      .map((k) => ({ k, score: phraseSimilarity(norm, k.phraseNorm) }))
      .filter((s) => s.score >= EXAMPLE_MIN_SIMILARITY && s.score < 1)
      .sort((a, b) => b.score - a.score)
    const seen = new Set<string>()
    const out: Array<{ message: string; tool: string; args: Record<string, unknown> }> = []
    for (const { k } of scored) {
      if (seen.has(k.phraseNorm)) continue
      seen.add(k.phraseNorm)
      out.push({ message: k.phrase, tool: k.tool, args: {} })
      if (out.length >= EXAMPLES_LIMIT) break
    }
    return out
  }

  /** La pregunta del turno, para entender un «no, me refiero a…» posterior. Caduca en 10 minutos. */
  async rememberLastMessage(userId: string, message: string): Promise<void> {
    await this.store.setLastMessage(userId, clean(message), this.clock())
  }

  /**
   * Correcciones por texto. Devuelve la respuesta de Lumi, o null si el mensaje no es una corrección
   * ni la respuesta a una pendiente (entonces el turno sigue su camino normal).
   */
  async handleTextTurn(learner: Learner, message: string): Promise<string | null> {
    const now = this.clock()
    const answer = confirmationAnswer(message)
    if (answer) {
      const pending = await this.store.findPendingConfirmation(learner.userId, new Date(now.getTime() - CONFIRMATION_WINDOW_MS))
      if (!pending) return null
      if (answer === 'no') {
        await this.transition(pending, 'rejected', learner.userId)
        return 'De acuerdo, no lo guardo.'
      }
      // Antes de guardar se vuelve a comprobar: la herramienta pudo deshabilitarse o el permiso cambiar.
      const tool = await this.usableTool(pending.tool, learner.permissionKeys)
      if (!tool) {
        await this.transition(pending, 'rejected', 'system')
        return 'Ya no puedo usar esa consulta, así que no lo guardo.'
      }
      await this.approveForUser(pending, learner.userId)
      return `Guardado. La próxima vez que digas «${pending.phrase}» usaré: ${tool.capability.toLowerCase()}.`
    }

    const target = correctionTarget(message)
    if (!target) return null
    const previous = await this.store.getLastMessage(learner.userId, new Date(now.getTime() - LAST_MESSAGE_TTL_MS))
    if (!previous || normalizePhrase(previous) === normalizePhrase(target)) return null

    const enabled = await this.deps.enabledTools()
    const byRules = matchTool(target, learner.permissionKeys, { now, timezone: this.deps.timezone, enabled })
    const learned = byRules ? null : await this.learnedTool(learner.userId, target, enabled)
    const toolName = byRules?.tool.name ?? learned?.tool ?? null
    const tool = toolName ? await this.usableTool(toolName, learner.permissionKeys) : null

    if (!tool) {
      // Sin herramienta para lo corregido: es una capacidad que falta, con lo que se quería como especificación.
      const result = await this.deps
        .recordMissing({ userId: learner.userId, conversationId: null, message: previous, need: target, module: 'none' })
        .catch(() => ({ recorded: false }))
      return result.recorded
        ? `Todavía no tengo una herramienta para «${target}». He registrado la petición para que la evalúen en Lumia Admin.`
        : `Todavía no tengo una herramienta para «${target}».`
    }
    await this.ensureRoom(learner.userId)
    const knowledge = await this.store.create({
      scope: 'user',
      userId: learner.userId,
      phrase: clean(previous),
      phraseNorm: normalizePhrase(previous),
      tool: tool.name,
      status: 'detected',
      source: 'text',
      conversationId: null,
      createdBy: learner.userId,
      now,
    })
    await this.store.addEvent({ knowledgeId: knowledge.id, at: now, by: learner.userId, action: 'created', to: 'detected' })
    return `¿Guardo que «${knowledge.phrase}» significa: ${tool.capability.toLowerCase()}? Responde «sí» para guardarlo o «no» para descartarlo.`
  }

  /* ───────────── Botón «No era esto» ───────────── */

  /** Herramientas que este usuario puede elegir: habilitadas, con permiso y usables por el selector. */
  async feedbackOptions(permissionKeys: readonly PermissionId[]): Promise<Array<{ tool: string; label: string; example: string }>> {
    const enabled = await this.deps.enabledTools()
    return this.deps.tools
      .filter((t) => t.selector && isToolEnabled(t, enabled) && canUseTool(t, permissionKeys))
      .map((t) => ({ tool: t.name, label: t.capability, example: t.example }))
  }

  async recordFeedback(
    learner: Learner,
    input: FeedbackInput,
  ): Promise<{ saved: 'interpretation'; knowledge: LumiKnowledge } | { saved: 'capability'; registered: boolean }> {
    if (input.wanted) {
      const result = await this.deps
        .recordMissing({ userId: learner.userId, conversationId: input.conversationId ?? null, message: input.message, need: input.wanted, module: 'none' })
        .catch(() => ({ recorded: false }))
      return { saved: 'capability', registered: result.recorded }
    }
    // Una orden de recordatorio la resuelve la etapa 0 del chat antes que lo aprendido: no se usaría nunca.
    if (parseAutomationCommand(input.message, this.clock(), this.deps.timezone).kind !== 'none') {
      throw AppError.badRequest('Esa frase es una orden de recordatorio: Lumi la resuelve siempre como recordatorio')
    }
    const tool = await this.usableTool(input.tool!, learner.permissionKeys)
    // Una memoria nunca concede permisos: solo se aprende lo que este usuario ya puede usar.
    if (!tool) throw AppError.badRequest('Esa consulta no está disponible para ti')
    const norm = normalizePhrase(input.message)
    if (!norm) throw AppError.badRequest('La frase no tiene contenido que se pueda aprender')
    const same = (await this.store.findByPhrase('user', learner.userId, norm, ['approved'])).find((k) => k.tool === tool.name)
    if (same) return { saved: 'interpretation', knowledge: same }
    await this.ensureRoom(learner.userId)
    const now = this.clock()
    const knowledge = await this.store.create({
      scope: 'user',
      userId: learner.userId,
      phrase: clean(input.message),
      phraseNorm: norm,
      tool: tool.name,
      status: 'detected',
      source: 'button',
      conversationId: null,
      createdBy: learner.userId,
      now,
    })
    await this.store.addEvent({ knowledgeId: knowledge.id, at: now, by: learner.userId, action: 'created', to: 'detected' })
    // El botón ya es la confirmación explícita del usuario.
    return { saved: 'interpretation', knowledge: await this.approveForUser(knowledge, learner.userId) }
  }

  /* ───────────── Panel de aprendizaje ───────────── */

  async list(query: ListKnowledgeQuery) {
    const { items, total } = await this.store.list(query)
    return { items: items.map((k) => this.view(k)), pagination: buildPaginationMeta(total, query.page, query.limit) }
  }

  async get(id: string) {
    const knowledge = await this.require(id)
    const events = await this.store.listEvents(id, 50)
    return {
      knowledge: this.view(knowledge),
      // Quién hizo cada cambio, sin identificadores: el propio usuario, un administrador o Lumi.
      events: events.map((e) => ({ at: e.at, action: e.action, from: e.from ?? null, to: e.to ?? null, by: e.by === 'system' ? 'system' : e.by === knowledge.userId ? 'user' : 'admin' })),
    }
  }

  async changeStatus(id: string, to: KnowledgeStatus, by: string) {
    const knowledge = await this.require(id)
    if (!(ADMIN_TRANSITIONS[knowledge.status] ?? []).includes(to)) {
      throw AppError.conflict(`Transición no permitida: ${knowledge.status} → ${to}`)
    }
    if (to === 'approved') {
      if (!this.deps.tools.some((t) => t.name === knowledge.tool)) throw AppError.conflict('La herramienta ya no existe')
      if (knowledge.scope === 'global') {
        const others = await this.store.findByPhrase('global', null, knowledge.phraseNorm, ['approved'])
        if (others.some((o) => o.id !== knowledge.id && o.tool !== knowledge.tool)) {
          throw AppError.conflict('Contradice otra interpretación global aprobada para la misma frase: rechaza una de las dos')
        }
        await this.transition(knowledge, 'approved', by)
      } else {
        await this.approveForUser(knowledge, by)
      }
    } else {
      await this.transition(knowledge, to, by)
    }
    return this.view(await this.require(id))
  }

  /**
   * Convierte una interpretación de usuario en global. Solo un administrador. Si ya hay una global
   * distinta para la misma frase, las dos quedan en revisión: nadie las usa hasta que se decida.
   */
  async promote(id: string, by: string) {
    const source = await this.require(id)
    if (source.scope !== 'user' || source.status !== 'approved') throw AppError.conflict('Solo se puede hacer global una interpretación de usuario aprobada')
    if (!this.deps.tools.some((t) => t.name === source.tool)) throw AppError.conflict('La herramienta ya no existe')
    const globals = await this.store.findByPhrase('global', null, source.phraseNorm, ['approved', 'pending_review'])
    if (globals.some((g) => g.tool === source.tool)) throw AppError.conflict('Ya existe una interpretación global igual')
    const now = this.clock()
    const contradicts = globals.filter((g) => g.status === 'approved')
    const created = await this.store.create({
      scope: 'global',
      userId: null,
      phrase: source.phrase,
      phraseNorm: source.phraseNorm,
      tool: source.tool,
      status: contradicts.length || globals.length ? 'pending_review' : 'approved',
      source: 'panel',
      conversationId: null,
      createdBy: by,
      now,
    })
    await this.store.addEvent({ knowledgeId: created.id, at: now, by, action: 'promoted', from: source.id, to: created.status })
    for (const other of contradicts) await this.transition(other, 'pending_review', by)
    return this.view(await this.require(created.id))
  }

  async delete(id: string, by: string): Promise<void> {
    const knowledge = await this.require(id)
    await this.store.addEvent({ knowledgeId: knowledge.id, at: this.clock(), by, action: 'deleted', from: knowledge.status })
    await this.store.delete(id)
  }

  /* ───────────── Internos ───────────── */

  private async usableTool(name: string, permissionKeys: readonly PermissionId[]): Promise<LumiTool<never> | null> {
    const tool = this.deps.tools.find((t) => t.name === name)
    if (!tool?.selector) return null
    const enabled = await this.deps.enabledTools()
    return isToolEnabled(tool, enabled) && canUseTool(tool, permissionKeys) ? tool : null
  }

  /** Aprueba para su usuario y retira la que tuviera para la misma frase con otra herramienta. */
  private async approveForUser(knowledge: LumiKnowledge, by: string): Promise<LumiKnowledge> {
    const previous = await this.store.findByPhrase('user', knowledge.userId, knowledge.phraseNorm, ['approved'])
    for (const old of previous) if (old.id !== knowledge.id) await this.transition(old, 'deprecated', by)
    await this.transition(knowledge, 'approved', by)
    return (await this.store.findById(knowledge.id))!
  }

  private async transition(knowledge: LumiKnowledge, to: KnowledgeStatus, by: string): Promise<void> {
    const now = this.clock()
    await this.store.setStatus(knowledge.id, to, now)
    await this.store.addEvent({ knowledgeId: knowledge.id, at: now, by, action: 'status', from: knowledge.status, to })
  }

  private async ensureRoom(userId: string): Promise<void> {
    if ((await this.store.countActiveForUser(userId)) >= USER_KNOWLEDGE_LIMIT) {
      throw AppError.conflict(`Máximo ${USER_KNOWLEDGE_LIMIT} interpretaciones por usuario`)
    }
  }

  private async require(id: string): Promise<LumiKnowledge> {
    const knowledge = await this.store.findById(id)
    if (!knowledge) throw AppError.notFound('Interpretación no encontrada')
    return knowledge
  }

  /** Lo que ve el panel: sin el identificador del usuario. */
  private view(k: LumiKnowledge) {
    const tool = this.deps.tools.find((t) => t.name === k.tool)
    return {
      id: k.id,
      kind: k.kind,
      scope: k.scope,
      phrase: k.phrase,
      phraseNorm: k.phraseNorm,
      tool: k.tool,
      status: k.status,
      source: k.source,
      uses: k.uses,
      lastUsedAt: k.lastUsedAt,
      createdAt: k.createdAt,
      updatedAt: k.updatedAt,
      toolLabel: tool?.capability ?? null,
      toolExists: Boolean(tool),
    }
  }
}


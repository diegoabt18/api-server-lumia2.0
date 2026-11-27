import { randomUUID } from 'node:crypto'
import { AppError } from '../../../common/errors/app.error.js'
import type {
  LumiAssistantClient,
  LumiChatResult,
  LumiConversationDetail,
  LumiConversationSummary,
  LumiStreamEvent,
  LumiTurnOptions,
} from '../infrastructure/lumi-assistant.client.js'
import type { LumiReference } from '../references/lumi-references.js'
import type { ConversationStore, StoredMessage } from './conversation.store.js'

/** Turnos anteriores que recibe el modelo (los mismos que usaba la IA Assistant). */
export const CONVERSATION_HISTORY_MESSAGES = 12

/** Identificador de mensaje generado por el cliente para reintentos sin duplicados. */
export const CLIENT_MESSAGE_ID = /^[A-Za-z0-9_-]{8,64}$/

export interface ConversationTurnOptions extends LumiTurnOptions {
  /** Id del mensaje en el cliente: un reintento con el mismo id no repite el turno. */
  clientMessageId?: string
}

type Assistant = Pick<LumiAssistantClient, 'chat' | 'chatStream'>

const NOT_FOUND = () => AppError.notFound('Conversación no encontrada')
const NOT_CONFIGURED = () =>
  new AppError(503, 'El asistente Lumi no está configurado', 'LUMI_NOT_CONFIGURED')

/** Título como lo calculaba la IA Assistant: el primer mensaje, normalizado y acotado. */
export function titleFrom(message: string): string {
  return message.split(/\s+/).filter(Boolean).join(' ').slice(0, 60) || 'Nueva conversación'
}

/**
 * Conversaciones de Lumi guardadas en el Server. Ofrece la misma interfaz que usaban las rutas con
 * el cliente de la IA Assistant (`chat`, `chatStream`, `recordExchange`, `listConversations`,
 * `getConversation`, `deleteConversation`): las rutas cambian de destinatario, no de forma, y los
 * contratos con Lumia Admin no cambian. La IA Assistant recibe el historial y no guarda nada.
 */
export class LumiConversationService {
  constructor(
    private readonly store: ConversationStore,
    /** null: el historial funciona, pero no se puede chatear con el modelo. */
    private readonly assistantClient: Assistant | null,
    private readonly now: () => Date = () => new Date(),
    private readonly historyMessages = CONVERSATION_HISTORY_MESSAGES,
  ) {}

  private get assistant(): Assistant {
    if (!this.assistantClient) throw NOT_CONFIGURED()
    return this.assistantClient
  }

  /** Conversación existente del usuario (404 si no es suya) o un id nuevo. */
  private async open(
    userId: string,
    conversationId: string | undefined,
  ): Promise<{ id: string; isNew: boolean }> {
    if (!conversationId) return { id: randomUUID(), isNew: true }
    if (!(await this.store.find(userId, conversationId))) throw NOT_FOUND()
    return { id: conversationId, isNew: false }
  }

  private async history(userId: string, id: string, isNew: boolean) {
    if (isNew) return []
    const recent = await this.store.recent(userId, id, this.historyMessages)
    return recent.map((m) => ({ role: m.role, content: m.content }))
  }

  private async ensure(userId: string, id: string, message: string): Promise<void> {
    if (!(await this.store.ensure(userId, id, titleFrom(message), this.now()))) throw NOT_FOUND()
  }

  /**
   * Reserva el mensaje del cliente. Devuelve la respuesta ya guardada si es un reintento de un turno
   * terminado; 409 si el mismo mensaje se está respondiendo.
   */
  private async claim(
    userId: string,
    id: string,
    message: string,
    clientMessageId: string | undefined,
  ): Promise<StoredMessage | null> {
    if (!clientMessageId) return null
    await this.ensure(userId, id, message)
    const claim = await this.store.claim(userId, id, clientMessageId, this.now())
    if (claim.kind === 'replay') return claim.answer
    if (claim.kind === 'busy') {
      throw new AppError(409, 'Ese mensaje ya se está respondiendo.', 'LUMI_MESSAGE_IN_PROGRESS')
    }
    return null
  }

  private async save(
    userId: string,
    id: string,
    message: string,
    answer: string,
    references: LumiReference[],
    clientMessageId: string | undefined,
  ): Promise<void> {
    await this.ensure(userId, id, message)
    await this.store.appendExchange(
      userId,
      id,
      { message, answer, references, ...(clientMessageId ? { clientMessageId } : {}) },
      this.now(),
    )
  }

  /** Turno resuelto sin modelo (herramientas, recordatorios, reglas). */
  async recordExchange(
    userId: string,
    message: string,
    answer: string,
    conversationId?: string,
    references: LumiReference[] = [],
  ): Promise<{ conversationId: string }> {
    const { id } = await this.open(userId, conversationId)
    await this.save(userId, id, message, answer, references, undefined)
    return { conversationId: id }
  }

  async chat(
    userId: string,
    message: string,
    conversationId?: string,
    context?: string,
    useWeb = false,
    options: ConversationTurnOptions = {},
  ): Promise<LumiChatResult> {
    const { clientMessageId, ...turn } = options
    const { id, isNew } = await this.open(userId, conversationId)
    const replay = await this.claim(userId, id, message, clientMessageId)
    if (replay) {
      return {
        conversationId: id,
        model: 'lumi-replay',
        response: replay.content,
        references: replay.references,
      }
    }
    const history = await this.history(userId, id, isNew)
    let result: LumiChatResult
    try {
      result = await this.assistant.chat(userId, message, id, context, useWeb, {
        ...turn,
        history,
        persist: false,
      })
    } catch (err) {
      if (clientMessageId) await this.store.release(userId, id, clientMessageId)
      throw err
    }
    await this.save(userId, id, message, result.response, result.references, clientMessageId)
    return { ...result, conversationId: id }
  }

  /**
   * Turno en streaming. Se guarda al recibir `done`; si el cliente se desconecta o el asistente falla
   * antes, no se guarda nada (como antes) y la reserva se libera para poder reintentar.
   */
  async *chatStream(
    userId: string,
    message: string,
    conversationId: string | undefined,
    signal: AbortSignal,
    context?: string,
    useWeb = false,
    options: ConversationTurnOptions = {},
  ): AsyncGenerator<LumiStreamEvent> {
    const { clientMessageId, ...turn } = options
    const { id, isNew } = await this.open(userId, conversationId)
    const replay = await this.claim(userId, id, message, clientMessageId)
    if (replay) {
      yield { type: 'start', conversationId: id }
      yield { type: 'token', text: replay.content }
      if (replay.references.length) yield { type: 'references', references: replay.references }
      yield { type: 'done', conversationId: id }
      return
    }
    const history = await this.history(userId, id, isNew)
    let saved = false
    let answer = ''
    let references: LumiReference[] = []
    try {
      const events = this.assistant.chatStream(userId, message, id, signal, context, useWeb, {
        ...turn,
        history,
        persist: false,
      })
      for await (const event of events) {
        if (event.type === 'token') answer += event.text
        if (event.type === 'references') references = event.references
        if (event.type === 'start') {
          yield { type: 'start', conversationId: id }
          continue
        }
        if (event.type === 'done') {
          await this.save(userId, id, message, answer, references, clientMessageId)
          saved = true
          yield { type: 'done', conversationId: id }
          continue
        }
        yield event
      }
    } finally {
      if (!saved && clientMessageId)
        await this.store.release(userId, id, clientMessageId).catch(() => undefined)
    }
  }

  async listConversations(
    userId: string,
    limit: number,
    offset: number,
  ): Promise<LumiConversationSummary[]> {
    const items = await this.store.list(userId, limit, offset)
    return items.map((c) => ({
      id: c.id,
      title: c.title,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
      messageCount: c.messageCount,
    }))
  }

  async getConversation(userId: string, id: string): Promise<LumiConversationDetail> {
    const conversation = await this.store.find(userId, id)
    if (!conversation || conversation.messageCount === 0) throw NOT_FOUND()
    const messages = await this.store.messages(userId, id)
    return {
      id: conversation.id,
      title: conversation.title,
      createdAt: conversation.createdAt.toISOString(),
      updatedAt: conversation.updatedAt.toISOString(),
      messages: messages.map((m) => ({
        id: m.seq,
        role: m.role,
        content: m.content,
        references: m.references,
        createdAt: m.createdAt.toISOString(),
      })),
    }
  }

  async deleteConversation(userId: string, id: string): Promise<void> {
    if (!(await this.store.delete(userId, id))) throw NOT_FOUND()
  }
}

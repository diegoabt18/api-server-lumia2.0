import type { Collection, Db } from 'mongodb'
import type { LumiReference } from '../references/lumi-references.js'

/**
 * Historial de conversaciones de Lumi, propiedad del Server (Lumi 2.0, Fase 1). Antes vivía en la
 * SQLite de la IA Assistant; ahora es compartido por todos los clientes del usuario (Lumia Admin y
 * LumiChat) y la IA Assistant recibe el historial en cada turno sin guardar nada.
 *
 * Idempotencia: un mensaje con `clientMessageId` se reserva antes de llamar al modelo. Un reintento
 * con el mismo id devuelve la respuesta ya guardada (o «en curso»), nunca un turno duplicado.
 */

export type MessageRole = 'user' | 'assistant'

export interface StoredMessage {
  /** Orden dentro de la conversación (1, 2, …). */
  seq: number
  role: MessageRole
  content: string
  references: LumiReference[]
  createdAt: Date
  clientMessageId?: string
}

export interface StoredConversation {
  id: string
  userId: string
  title: string
  createdAt: Date
  updatedAt: Date
  messageCount: number
}

export type ClaimResult =
  | { kind: 'claimed' }
  /** El mismo mensaje ya tiene respuesta: se devuelve sin repetir el turno. */
  | { kind: 'replay'; answer: StoredMessage }
  /** El mismo mensaje se está respondiendo ahora. */
  | { kind: 'busy' }

export interface ExchangeInput {
  message: string
  answer: string
  references: LumiReference[]
  clientMessageId?: string
}

export interface ConversationStore {
  /** Crea la conversación si no existe. false si el id ya es de otro usuario. */
  ensure(userId: string, id: string, title: string, now: Date): Promise<boolean>
  find(userId: string, id: string): Promise<StoredConversation | null>
  /** Conversaciones con mensajes, de la más reciente a la más antigua. */
  list(userId: string, limit: number, offset: number): Promise<StoredConversation[]>
  /** Mensajes completos, en orden. */
  messages(userId: string, id: string): Promise<StoredMessage[]>
  /** Últimos `limit` mensajes completos, en orden. */
  recent(userId: string, id: string, limit: number): Promise<StoredMessage[]>
  /** Reserva un mensaje del cliente antes de responderlo. La conversación debe existir. */
  claim(userId: string, id: string, clientMessageId: string, now: Date): Promise<ClaimResult>
  /** Libera una reserva que no llegó a respuesta (error o desconexión): se podrá reintentar. */
  release(userId: string, id: string, clientMessageId: string): Promise<void>
  /** Guarda pregunta y respuesta seguidas (completa la reserva si había una). */
  appendExchange(userId: string, id: string, exchange: ExchangeInput, now: Date): Promise<void>
  delete(userId: string, id: string): Promise<boolean>
}

/* ───────────────────────── Memoria (pruebas y desarrollo sin MongoDB) ───────────────────────── */

interface MemoryConversation extends StoredConversation {
  messages: StoredMessage[]
  /** clientMessageId → reservado (sin respuesta todavía). */
  claims: Set<string>
}

export class MemoryConversationStore implements ConversationStore {
  readonly items = new Map<string, MemoryConversation>()

  private owned(userId: string, id: string): MemoryConversation | null {
    const c = this.items.get(id)
    return c && c.userId === userId ? c : null
  }

  async ensure(userId: string, id: string, title: string, now: Date): Promise<boolean> {
    const existing = this.items.get(id)
    if (existing) return existing.userId === userId
    this.items.set(id, {
      id,
      userId,
      title,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      messages: [],
      claims: new Set(),
    })
    return true
  }

  async find(userId: string, id: string): Promise<StoredConversation | null> {
    const c = this.owned(userId, id)
    return c ? summary(c) : null
  }

  async list(userId: string, limit: number, offset: number): Promise<StoredConversation[]> {
    return [...this.items.values()]
      .filter((c) => c.userId === userId && c.messageCount > 0)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(offset, offset + limit)
      .map(summary)
  }

  async messages(userId: string, id: string): Promise<StoredMessage[]> {
    return [...(this.owned(userId, id)?.messages ?? [])]
  }

  async recent(userId: string, id: string, limit: number): Promise<StoredMessage[]> {
    return limit > 0 ? (this.owned(userId, id)?.messages ?? []).slice(-limit) : []
  }

  async claim(userId: string, id: string, clientMessageId: string, _now?: Date): Promise<ClaimResult> {
    const c = this.owned(userId, id)
    if (!c) throw new Error('conversation not found')
    const asked = c.messages.findIndex(
      (m) => m.role === 'user' && m.clientMessageId === clientMessageId,
    )
    if (asked >= 0) {
      const answer = c.messages[asked + 1]
      return answer ? { kind: 'replay', answer } : { kind: 'busy' }
    }
    if (c.claims.has(clientMessageId)) return { kind: 'busy' }
    c.claims.add(clientMessageId)
    return { kind: 'claimed' }
  }

  async release(userId: string, id: string, clientMessageId: string): Promise<void> {
    this.owned(userId, id)?.claims.delete(clientMessageId)
  }

  async appendExchange(
    userId: string,
    id: string,
    exchange: ExchangeInput,
    now: Date,
  ): Promise<void> {
    const c = this.owned(userId, id)
    if (!c) throw new Error('conversation not found')
    if (exchange.clientMessageId) c.claims.delete(exchange.clientMessageId)
    const seq = c.messages.length
    c.messages.push(
      {
        seq: seq + 1,
        role: 'user',
        content: exchange.message,
        references: [],
        createdAt: now,
        ...(exchange.clientMessageId ? { clientMessageId: exchange.clientMessageId } : {}),
      },
      {
        seq: seq + 2,
        role: 'assistant',
        content: exchange.answer,
        references: exchange.references,
        createdAt: now,
      },
    )
    c.messageCount = c.messages.length
    c.updatedAt = now
  }

  async delete(userId: string, id: string): Promise<boolean> {
    if (!this.owned(userId, id)) return false
    this.items.delete(id)
    return true
  }
}

function summary(c: StoredConversation): StoredConversation {
  return {
    id: c.id,
    userId: c.userId,
    title: c.title,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    messageCount: c.messageCount,
  }
}

/* ───────────────────────── MongoDB ───────────────────────── */

interface ConversationDocument {
  _id: string
  userId: string
  title: string
  createdAt: Date
  updatedAt: Date
  messageCount: number
  /** Último `seq` asignado. */
  lastSeq: number
}

interface MessageDocument {
  conversationId: string
  userId: string
  /** Ausente mientras la pregunta está reservada y sin respuesta. */
  seq?: number
  role: MessageRole
  content: string
  references: LumiReference[]
  createdAt: Date
  clientMessageId?: string
  status: 'pending' | 'complete'
}

export const CONVERSATIONS_COLLECTION = 'lumi_conversations'
export const MESSAGES_COLLECTION = 'lumi_messages'

export class MongoConversationStore implements ConversationStore {
  private readonly conversations: Collection<ConversationDocument>
  private readonly messagesCol: Collection<MessageDocument>

  constructor(db: Db) {
    this.conversations = db.collection<ConversationDocument>(CONVERSATIONS_COLLECTION)
    this.messagesCol = db.collection<MessageDocument>(MESSAGES_COLLECTION)
  }

  async ensureIndexes(): Promise<void> {
    await this.conversations.createIndex(
      { userId: 1, updatedAt: -1 },
      { name: 'lumi_conversations_user_updated' },
    )
    await this.messagesCol.createIndex(
      { conversationId: 1, seq: 1 },
      {
        unique: true,
        partialFilterExpression: { seq: { $exists: true } },
        name: 'lumi_messages_conversation_seq',
      },
    )
    await this.messagesCol.createIndex(
      { conversationId: 1, clientMessageId: 1 },
      {
        unique: true,
        partialFilterExpression: { clientMessageId: { $exists: true } },
        name: 'lumi_messages_client_id',
      },
    )
  }

  async ensure(userId: string, id: string, title: string, now: Date): Promise<boolean> {
    const doc = await this.conversations.findOneAndUpdate(
      { _id: id },
      {
        $setOnInsert: {
          userId,
          title,
          createdAt: now,
          updatedAt: now,
          messageCount: 0,
          lastSeq: 0,
        },
      },
      { upsert: true, returnDocument: 'after' },
    )
    return doc?.userId === userId
  }

  async find(userId: string, id: string): Promise<StoredConversation | null> {
    const doc = await this.conversations.findOne({ _id: id, userId })
    return doc ? fromConversation(doc) : null
  }

  async list(userId: string, limit: number, offset: number): Promise<StoredConversation[]> {
    const docs = await this.conversations
      .find({ userId, messageCount: { $gt: 0 } })
      .sort({ updatedAt: -1 })
      .skip(offset)
      .limit(limit)
      .toArray()
    return docs.map(fromConversation)
  }

  async messages(userId: string, id: string): Promise<StoredMessage[]> {
    const docs = await this.messagesCol
      .find({ conversationId: id, userId, status: 'complete' })
      .sort({ seq: 1 })
      .toArray()
    return docs.map(fromMessage)
  }

  async recent(userId: string, id: string, limit: number): Promise<StoredMessage[]> {
    if (limit <= 0) return []
    const docs = await this.messagesCol
      .find({ conversationId: id, userId, status: 'complete' })
      .sort({ seq: -1 })
      .limit(limit)
      .toArray()
    return docs.reverse().map(fromMessage)
  }

  async claim(
    userId: string,
    id: string,
    clientMessageId: string,
    now: Date,
  ): Promise<ClaimResult> {
    try {
      await this.messagesCol.insertOne({
        conversationId: id,
        userId,
        role: 'user',
        content: '',
        references: [],
        createdAt: now,
        clientMessageId,
        status: 'pending',
      })
      return { kind: 'claimed' }
    } catch (err) {
      if (!isDuplicateKey(err)) throw err
    }
    const asked = await this.messagesCol.findOne({ conversationId: id, userId, clientMessageId })
    if (!asked || asked.status === 'pending' || asked.seq === undefined) return { kind: 'busy' }
    const answer = await this.messagesCol.findOne({
      conversationId: id,
      userId,
      seq: asked.seq + 1,
    })
    return answer ? { kind: 'replay', answer: fromMessage(answer) } : { kind: 'busy' }
  }

  async release(userId: string, id: string, clientMessageId: string): Promise<void> {
    await this.messagesCol.deleteOne({
      conversationId: id,
      userId,
      clientMessageId,
      status: 'pending',
    })
  }

  async appendExchange(
    userId: string,
    id: string,
    exchange: ExchangeInput,
    now: Date,
  ): Promise<void> {
    const before = await this.conversations.findOneAndUpdate(
      { _id: id, userId },
      { $inc: { lastSeq: 2, messageCount: 2 }, $set: { updatedAt: now } },
      { returnDocument: 'before' },
    )
    if (!before) throw new Error('conversation not found')
    const seq = before.lastSeq + 1
    if (exchange.clientMessageId) {
      await this.messagesCol.updateOne(
        { conversationId: id, userId, clientMessageId: exchange.clientMessageId },
        {
          $set: { seq, content: exchange.message, status: 'complete', createdAt: now },
          $setOnInsert: { conversationId: id, userId, role: 'user', references: [] },
        },
        { upsert: true },
      )
    } else {
      await this.messagesCol.insertOne({
        conversationId: id,
        userId,
        seq,
        role: 'user',
        content: exchange.message,
        references: [],
        createdAt: now,
        status: 'complete',
      })
    }
    await this.messagesCol.insertOne({
      conversationId: id,
      userId,
      seq: seq + 1,
      role: 'assistant',
      content: exchange.answer,
      references: exchange.references,
      createdAt: now,
      status: 'complete',
    })
  }

  async delete(userId: string, id: string): Promise<boolean> {
    const res = await this.conversations.deleteOne({ _id: id, userId })
    if (res.deletedCount === 0) return false
    await this.messagesCol.deleteMany({ conversationId: id, userId })
    return true
  }
}

function fromConversation(doc: ConversationDocument): StoredConversation {
  return {
    id: doc._id,
    userId: doc.userId,
    title: doc.title,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    messageCount: doc.messageCount,
  }
}

function fromMessage(doc: MessageDocument): StoredMessage {
  return {
    seq: doc.seq ?? 0,
    role: doc.role,
    content: doc.content,
    references: doc.references ?? [],
    createdAt: doc.createdAt,
    ...(doc.clientMessageId ? { clientMessageId: doc.clientMessageId } : {}),
  }
}

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000
}

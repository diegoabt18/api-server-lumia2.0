import type { Collection, Db } from 'mongodb'
import type { LumiEntityRef } from '../tools/tool.types.js'

/**
 * Context Manager de Lumi: la entidad de la que se está hablando en una conversación ("el pedido
 * ORD-CB07203E" → "¿y sus pagos?"). Caduca sola: no se asume que una entidad sigue activa
 * indefinidamente. Solo guarda la referencia visible (nunca datos de clientes); cada uso vuelve a
 * pasar por los permisos de la herramienta que la lee.
 */

export const ACTIVE_ENTITY_TTL_MS = 30 * 60_000

export interface ActiveEntityStore {
  get(userId: string, conversationId: string, now: Date): Promise<LumiEntityRef | null>
  set(userId: string, conversationId: string, entity: LumiEntityRef, now: Date): Promise<void>
}

/** Implementación en memoria (pruebas y desarrollo sin Mongo). */
export class MemoryActiveEntities implements ActiveEntityStore {
  private readonly items = new Map<string, { entity: LumiEntityRef; expiresAt: Date }>()

  async get(userId: string, conversationId: string, now: Date): Promise<LumiEntityRef | null> {
    const item = this.items.get(`${userId}|${conversationId}`)
    return item && item.expiresAt > now ? item.entity : null
  }

  async set(userId: string, conversationId: string, entity: LumiEntityRef, now: Date): Promise<void> {
    this.items.set(`${userId}|${conversationId}`, { entity, expiresAt: new Date(now.getTime() + ACTIVE_ENTITY_TTL_MS) })
  }
}

interface ActiveEntityDocument {
  userId: string
  conversationId: string
  kind: LumiEntityRef['kind']
  label: string
  updatedAt: Date
  expiresAt: Date
}

/** Persistencia en identity_db (`lumi_context`). El índice TTL borra las caducadas. */
export class MongoActiveEntities implements ActiveEntityStore {
  private readonly collection: Collection<ActiveEntityDocument>

  constructor(db: Db) {
    this.collection = db.collection<ActiveEntityDocument>('lumi_context')
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'lumi_context_ttl' })
    await this.collection.createIndex(
      { userId: 1, conversationId: 1 },
      { unique: true, name: 'lumi_context_user_conversation' },
    )
  }

  async get(userId: string, conversationId: string, now: Date): Promise<LumiEntityRef | null> {
    const doc = await this.collection.findOne({ userId, conversationId, expiresAt: { $gt: now } })
    return doc ? { kind: doc.kind, label: doc.label } : null
  }

  async set(userId: string, conversationId: string, entity: LumiEntityRef, now: Date): Promise<void> {
    await this.collection.updateOne(
      { userId, conversationId },
      {
        $set: {
          kind: entity.kind,
          label: entity.label.slice(0, 120),
          updatedAt: now,
          expiresAt: new Date(now.getTime() + ACTIVE_ENTITY_TTL_MS),
        },
      },
      { upsert: true },
    )
  }
}

/** Línea de contexto para el selector. La redacta el Server; nunca texto libre del navegador. */
export function entityContextLine(entity: LumiEntityRef | null): string | undefined {
  if (!entity) return undefined
  const label = entity.label.replace(/[\r\n"«»]+/g, ' ').slice(0, 120)
  return entity.kind === 'order' ? `pedido abierto: ${label}` : `producto abierto: ${label}`
}

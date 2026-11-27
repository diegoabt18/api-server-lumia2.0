import { z } from 'zod'
import { parseLumiReferences } from '../references/lumi-references.js'

/**
 * Migración del historial de la SQLite de la IA Assistant a MongoDB (Lumi 2.0, Fase 1). Recibe el JSON
 * de `local-ai-assistant/scripts/export_conversations.py` y decide qué se inserta. Idempotente: una
 * conversación que ya existe con el mismo dueño y el mismo número de mensajes se salta; si difiere,
 * es un conflicto y no se toca (se revisa a mano).
 */

const messageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1),
  references: z.array(z.unknown()).default([]),
  createdAt: z.string().datetime({ offset: true }).nullable(),
})

const conversationSchema = z.object({
  id: z.string().uuid(),
  userRef: z.string().min(1).max(64),
  title: z.string().max(120),
  createdAt: z.string().datetime({ offset: true }).nullable(),
  updatedAt: z.string().datetime({ offset: true }).nullable(),
  messages: z.array(messageSchema),
})

export const conversationExportSchema = z.object({
  format: z.literal(1),
  exportedAt: z.string(),
  conversations: z.array(conversationSchema),
  skippedWithoutOwner: z.number().int().min(0).default(0),
})

export type ConversationExport = z.infer<typeof conversationExportSchema>

export interface ExistingConversation {
  userId: string
  messageCount: number
}

export interface ImportConversationDoc {
  _id: string
  userId: string
  title: string
  createdAt: Date
  updatedAt: Date
  messageCount: number
  lastSeq: number
}

export interface ImportMessageDoc {
  conversationId: string
  userId: string
  seq: number
  role: 'user' | 'assistant'
  content: string
  references: ReturnType<typeof parseLumiReferences>
  createdAt: Date
  status: 'complete'
}

export interface ImportPlan {
  conversations: ImportConversationDoc[]
  messages: ImportMessageDoc[]
  /** Ya migradas con el mismo dueño y número de mensajes. */
  alreadyImported: string[]
  /** Existe con otro dueño o con otro número de mensajes: no se toca. */
  conflicts: Array<{ id: string; reason: string }>
  /** Sin mensajes: no se migran (no aparecían en el historial). */
  empty: string[]
}

const date = (value: string | null, fallback: Date) => (value ? new Date(value) : fallback)

export function planImport(
  data: ConversationExport,
  existing: Map<string, ExistingConversation>,
): ImportPlan {
  const plan: ImportPlan = {
    conversations: [],
    messages: [],
    alreadyImported: [],
    conflicts: [],
    empty: [],
  }
  const exportedAt = new Date(data.exportedAt)
  for (const conv of data.conversations) {
    if (conv.messages.length === 0) {
      plan.empty.push(conv.id)
      continue
    }
    const current = existing.get(conv.id)
    if (current) {
      if (current.userId !== conv.userRef) {
        plan.conflicts.push({ id: conv.id, reason: 'owned by another user' })
      } else if (current.messageCount !== conv.messages.length) {
        plan.conflicts.push({
          id: conv.id,
          reason: `has ${current.messageCount} messages, export has ${conv.messages.length}`,
        })
      } else {
        plan.alreadyImported.push(conv.id)
      }
      continue
    }
    const createdAt = date(conv.createdAt, exportedAt)
    plan.conversations.push({
      _id: conv.id,
      userId: conv.userRef,
      title: conv.title || 'Nueva conversación',
      createdAt,
      updatedAt: date(conv.updatedAt, createdAt),
      messageCount: conv.messages.length,
      lastSeq: conv.messages.length,
    })
    conv.messages.forEach((m, i) => {
      plan.messages.push({
        conversationId: conv.id,
        userId: conv.userRef,
        seq: i + 1,
        role: m.role,
        content: m.content,
        references: parseLumiReferences(m.references),
        createdAt: date(m.createdAt, createdAt),
        status: 'complete',
      })
    })
  }
  return plan
}

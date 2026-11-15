import { z } from 'zod'
import { plainText } from '../../selector/selector-text.js'

/**
 * Learning Engine de Lumi (fase F): interpretaciones aprendidas («cuando digo X me refiero a la
 * herramienta Y»).
 *
 * Reglas que no cambian:
 * - Una interpretación nunca concede permisos: cada vez que se usa, la herramienta vuelve a pasar
 *   por el permiso, la puerta de habilitación y la validación de su entrada.
 * - Solo se guarda frase → herramienta. Los datos (periodo, referencia…) se sacan otra vez del
 *   mensaje con los validadores del Server.
 * - Alcance de usuario por defecto. Global solo si un administrador la aprueba en el panel.
 * - Nada reentrena el modelo: Qwen solo recibe ejemplos en el mensaje.
 */

export const KNOWLEDGE_STATUSES = ['detected', 'pending_review', 'approved', 'rejected', 'deprecated'] as const
export type KnowledgeStatus = (typeof KNOWLEDGE_STATUSES)[number]

export const KNOWLEDGE_SCOPES = ['user', 'global'] as const
export type KnowledgeScope = (typeof KNOWLEDGE_SCOPES)[number]

/** button: «No era esto» · text: «no, me refiero a…» confirmado con «sí» · panel: un administrador. */
export const KNOWLEDGE_SOURCES = ['button', 'text', 'panel'] as const
export type KnowledgeSource = (typeof KNOWLEDGE_SOURCES)[number]

export const PHRASE_MAX_CHARS = 300
/** Interpretaciones activas por usuario (evita que alguien llene la colección). */
export const USER_KNOWLEDGE_LIMIT = 200
/** Una corrección por texto espera el «sí» como mucho este tiempo. */
export const CONFIRMATION_WINDOW_MS = 10 * 60_000
/** La última pregunta del usuario se recuerda este tiempo para entender «no, me refiero a…». */
export const LAST_MESSAGE_TTL_MS = 10 * 60_000
/** Ejemplos parecidos que se envían al selector. */
export const EXAMPLES_LIMIT = 3
export const EXAMPLE_MIN_SIMILARITY = 0.34

export interface LumiKnowledge {
  id: string
  kind: 'interpretation'
  scope: KnowledgeScope
  /** null en las globales. */
  userId: string | null
  phrase: string
  phraseNorm: string
  tool: string
  status: KnowledgeStatus
  source: KnowledgeSource
  /** Solo mientras espera la confirmación de una corrección por texto. */
  conversationId: string | null
  uses: number
  lastUsedAt: Date | null
  createdBy: string
  createdAt: Date
  updatedAt: Date
}

/** Transiciones que puede pedir un administrador. */
export const ADMIN_TRANSITIONS: Readonly<Partial<Record<KnowledgeStatus, readonly KnowledgeStatus[]>>> = {
  detected: ['approved', 'rejected'],
  pending_review: ['approved', 'rejected'],
  approved: ['deprecated', 'rejected'],
  deprecated: ['approved'],
  rejected: ['approved'],
}

/* ───────────── Texto ───────────── */

/** Cortesía, verbos de petición y artículos: no cambian lo que se pide. */
const FILLERS = new Set(
  (
    'por favor porfa porfavor lumi oye hola buenas buenos dias tardes noches me puedes podrias dime decime ' +
    'muestrame mostrar ensename quiero queria necesito ver saber el la los las un una unos unas de del al y'
  ).split(' '),
)

/** Forma normalizada de una frase: sin tildes, signos, cortesía ni artículos. */
export function normalizePhrase(text: string): string {
  return plainText(text)
    .split(' ')
    // «dime:» → «dime»; «9:30» se conserva.
    .map((w) => w.replace(/^[:-]+|[:-]+$/g, ''))
    .filter((w) => w && !FILLERS.has(w))
    .join(' ')
}

/** Parecido entre dos frases normalizadas (Jaccard de palabras). */
export function phraseSimilarity(a: string, b: string): number {
  const wa = new Set(a.split(' ').filter(Boolean))
  const wb = new Set(b.split(' ').filter(Boolean))
  if (!wa.size || !wb.size) return 0
  let shared = 0
  for (const w of wa) if (wb.has(w)) shared++
  return shared / (wa.size + wb.size - shared)
}

/**
 * «no, me refiero a X», «quise decir X», «no era eso, quería X»: devuelve X o null.
 * Solo frases que empiezan así; «no» a secas es otra cosa.
 */
const CORRECTION =
  /^(?:no\s+)?(?:me refiero a|me referia a|quise decir|queria decir|lo que queria (?:era|es)|no era eso\s+(?:quiero|queria|necesito)?|no\s+(?:quiero|queria))\s+(.{3,})$/

export function correctionTarget(message: string): string | null {
  const text = plainText(message)
  const match = CORRECTION.exec(text)
  return match ? match[1]!.trim() : null
}

const YES = /^(?:si|sí|claro|dale|ok|okay|guardalo|guardala|vale|correcto|de acuerdo)(?:\s+(?:por favor|guardalo|gracias))?$/
const NO = /^(?:no|nop|no gracias|descartalo|descartala|mejor no|cancelar|cancela)$/

export function confirmationAnswer(message: string): 'yes' | 'no' | null {
  const text = plainText(message)
  if (YES.test(text)) return 'yes'
  if (NO.test(text)) return 'no'
  return null
}

/* ───────────── Entrada de las rutas ───────────── */

export const feedbackSchema = z
  .object({
    /** La pregunta del usuario a la que respondió Lumi. */
    message: z.string().trim().min(2).max(PHRASE_MAX_CHARS),
    conversationId: z.string().trim().max(64).optional(),
    /** Herramienta correcta, elegida entre las permitidas. */
    tool: z.string().trim().max(60).optional(),
    /** O lo que quería, si ninguna herramienta lo hace. */
    wanted: z.string().trim().min(3).max(300).optional(),
  })
  .strict()
  .refine((v) => Boolean(v.tool) !== Boolean(v.wanted), 'Indica la herramienta o lo que querías, no ambas')
export type FeedbackInput = z.infer<typeof feedbackSchema>

export const knowledgeIdParamsSchema = z.object({ id: z.string().regex(/^[a-f0-9]{24}$/) })

export const listKnowledgeQuerySchema = z.object({
  scope: z.enum(KNOWLEDGE_SCOPES).optional(),
  status: z.enum(KNOWLEDGE_STATUSES).optional(),
  tool: z.string().trim().max(60).optional(),
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})
export type ListKnowledgeQuery = z.infer<typeof listKnowledgeQuerySchema>

export const changeKnowledgeStatusSchema = z.object({ status: z.enum(KNOWLEDGE_STATUSES) }).strict()

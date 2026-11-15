import type {
  KnowledgeScope,
  KnowledgeSource,
  KnowledgeStatus,
  ListKnowledgeQuery,
  LumiKnowledge,
} from './knowledge.types.js'

export interface NewKnowledge {
  scope: KnowledgeScope
  userId: string | null
  phrase: string
  phraseNorm: string
  tool: string
  status: KnowledgeStatus
  source: KnowledgeSource
  conversationId: string | null
  createdBy: string
  now: Date
}

export interface KnowledgeEvent {
  knowledgeId: string
  at: Date
  by: string
  action: 'created' | 'status' | 'used' | 'promoted' | 'deleted'
  from?: string
  to?: string
}

/** Interpretaciones aprendidas, su auditoría y la última pregunta de cada usuario. */
export interface KnowledgeStore {
  create(input: NewKnowledge): Promise<LumiKnowledge>
  findById(id: string): Promise<LumiKnowledge | null>
  /** Interpretaciones aprobadas aplicables a este usuario (las suyas y las globales) con esa frase. */
  findApproved(userId: string, phraseNorm: string): Promise<LumiKnowledge[]>
  /** Aprobadas del usuario y globales más recientes (para elegir ejemplos parecidos). */
  listApprovedFor(userId: string, limit: number): Promise<LumiKnowledge[]>
  /** De un alcance concreto con esa frase y estado. */
  findByPhrase(scope: KnowledgeScope, userId: string | null, phraseNorm: string, statuses: readonly KnowledgeStatus[]): Promise<LumiKnowledge[]>
  /** La corrección por texto más reciente esperando el «sí» de este usuario. */
  findPendingConfirmation(userId: string, since: Date): Promise<LumiKnowledge | null>
  countActiveForUser(userId: string): Promise<number>
  setStatus(id: string, status: KnowledgeStatus, at: Date): Promise<void>
  markUsed(id: string, at: Date): Promise<void>
  delete(id: string): Promise<boolean>
  list(query: ListKnowledgeQuery): Promise<{ items: LumiKnowledge[]; total: number }>
  addEvent(event: KnowledgeEvent): Promise<void>
  listEvents(knowledgeId: string, limit: number): Promise<KnowledgeEvent[]>
  setLastMessage(userId: string, message: string, at: Date): Promise<void>
  getLastMessage(userId: string, since: Date): Promise<string | null>
}

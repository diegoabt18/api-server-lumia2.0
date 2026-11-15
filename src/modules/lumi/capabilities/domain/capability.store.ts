import type {
  CapabilityHistoryEntry,
  CapabilityLastTest,
  CapabilityModule,
  CapabilityPriority,
  CapabilitySpec,
  CapabilityStatus,
  ListCapabilitiesQuery,
  LumiCapability,
} from './capability.types.js'

export interface NewCapability {
  key: string
  title: string
  module: CapabilityModule
  signature: string
  keywords: string[]
  sample: string
  possibleDuplicateOf: string | null
  now: Date
}

export interface NewCapabilityRequest {
  capabilityId: string
  userId: string
  conversationId: string | null
  message: string
  need: string
  module: CapabilityModule
  signature: string
  createdAt: Date
}

export interface CapabilityPatch {
  title?: string
  description?: string
  module?: CapabilityModule
  priority?: CapabilityPriority
  spec?: CapabilitySpec
  status?: CapabilityStatus
  mergedInto?: string | null
  possibleDuplicateOf?: string | null
  lastTest?: CapabilityLastTest
}

/** Alta o enlace de la capacidad de una herramienta del registro (sincronización al arrancar). */
export interface ToolCapabilityInput {
  key: string
  title: string
  module: CapabilityModule
  toolName: string
  /** Estado si la capacidad no existía. Si ya existe, su estado no se toca. */
  initialStatus: CapabilityStatus
  now: Date
}

export interface CapabilityStats {
  total: number
  byStatus: Partial<Record<CapabilityStatus, number>>
  byModule: Partial<Record<CapabilityModule, number>>
  requestsSince: number
}

/** Puerto de persistencia del Capability Manager. */
export interface CapabilityStore {
  create(input: NewCapability): Promise<LumiCapability>
  findById(id: string): Promise<LumiCapability | null>
  /** Capacidades que comparten alguna palabra clave, también las fusionadas (como mucho `limit`). */
  findCandidates(keywords: readonly string[], limit: number): Promise<LumiCapability[]>
  /** Suma una petición: contador, última vez y frase de ejemplo. */
  addRequest(id: string, sample: string, at: Date): Promise<void>
  insertRequest(request: NewCapabilityRequest): Promise<void>
  /** ¿Pidió ya este usuario lo mismo después de `since`? (control de repetición) */
  hasRecentRequest(userId: string, signature: string, since: Date): Promise<boolean>
  list(query: ListCapabilitiesQuery): Promise<{ items: LumiCapability[]; total: number }>
  stats(since: Date): Promise<CapabilityStats>
  recentRequests(capabilityId: string, limit: number): Promise<Array<{ message: string; createdAt: Date }>>
  distinctUsers(capabilityId: string): Promise<number>
  /** Aplica el cambio y añade la entrada al historial (acotado). */
  update(id: string, patch: CapabilityPatch, entry: CapabilityHistoryEntry, at: Date): Promise<void>
  /** Fusión: mueve peticiones, contador y ejemplos de `sourceId` a `targetId`. */
  absorb(targetId: string, sourceId: string, requestCount: number, samples: string[], entry: CapabilityHistoryEntry, at: Date): Promise<void>
  /** Crea la capacidad de la herramienta o la enlaza si ya existe. Devuelve si cambió algo. */
  upsertForTool(input: ToolCapabilityInput): Promise<'created' | 'linked' | 'unchanged'>
  /** Herramientas cuya capacidad está `enabled`. */
  enabledToolNames(): Promise<string[]>
}

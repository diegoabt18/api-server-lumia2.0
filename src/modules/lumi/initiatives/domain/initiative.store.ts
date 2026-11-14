import type { InitiativeCandidate } from './initiative.detectors.js'
import type { InitiativeLevel, InitiativeState, LumiInitiative } from './initiative.types.js'

export interface NewInitiative {
  userId: string
  kind: InitiativeCandidate['kind']
  subjectKey: string
  dedupKey: string
  title: string
  detail: string
  priority: InitiativeCandidate['priority']
  state: InitiativeState
  openCount: number
  firstSeenAt: Date
  lastSeenAt: Date
  stateChangedAt: Date
}

export interface InitiativePatch {
  title?: string
  detail?: string
  priority?: InitiativeCandidate['priority']
  state?: InitiativeState
  openCount?: number
  lastSeenAt?: Date
  stateChangedAt?: Date
  resolvedAt?: Date | null
}

/** Puerto de persistencia de iniciativas y de su configuración por usuario. */
export interface InitiativeStore {
  /** Inserta una iniciativa. Devuelve null si ya existe la misma (userId, dedupKey). */
  insert(item: NewInitiative): Promise<LumiInitiative | null>
  findForUser(id: string, userId: string): Promise<LumiInitiative | null>
  listForUser(userId: string, options: { state?: InitiativeState; limit: number }): Promise<LumiInitiative[]>
  update(id: string, patch: InitiativePatch): Promise<void>
  getLevel(userId: string): Promise<InitiativeLevel>
  setLevel(userId: string, level: InitiativeLevel): Promise<void>
  /** Usuarios con una revisión diaria de iniciativas activa: solo a ellos se les generan iniciativas. */
  listUsersWithReviewRoutine(): Promise<string[]>
}

import type {
  CapabilityPhrase,
  CapabilityTestRun,
  ExpectedStatus,
  PhraseResult,
  PhraseRole,
  RunStatus,
  RunSummary,
} from './capability-test.types.js'

export interface NewPhrase {
  capabilityId: string
  text: string
  role: PhraseRole
  expectedStatus: ExpectedStatus
  expectedTool: string | null
  critical: boolean
  createdBy: string
  createdAt: Date
}

export interface NewRun {
  capabilityId: string
  kind: CapabilityTestRun['kind']
  forceSelector: boolean
  by: string
  createdAt: Date
}

export interface RunPatch {
  status?: RunStatus
  results?: PhraseResult[]
  summary?: RunSummary | null
  error?: string | null
  finishedAt?: Date | null
}

/** Frases de prueba y ejecuciones del entorno de pruebas (fase D). */
export interface CapabilityTestStore {
  addPhrase(phrase: NewPhrase): Promise<CapabilityPhrase>
  listPhrases(capabilityId: string): Promise<CapabilityPhrase[]>
  countPhrases(capabilityId: string): Promise<number>
  deletePhrase(capabilityId: string, phraseId: string): Promise<boolean>
  updatePhrase(
    capabilityId: string,
    phraseId: string,
    patch: Partial<Pick<CapabilityPhrase, 'role' | 'expectedStatus' | 'expectedTool' | 'critical'>>,
  ): Promise<CapabilityPhrase | null>
  /** Fusión: las frases de la origen pasan al destino. */
  movePhrases(fromCapabilityId: string, toCapabilityId: string): Promise<void>
  createRun(run: NewRun): Promise<CapabilityTestRun>
  updateRun(runId: string, patch: RunPatch): Promise<void>
  getRun(capabilityId: string, runId: string): Promise<CapabilityTestRun | null>
  /** Las últimas ejecuciones, sin el detalle por frase. */
  listRuns(capabilityId: string, limit: number): Promise<Array<Omit<CapabilityTestRun, 'results'>>>
  /** Una ejecución en curso iniciada después de `since` (para no lanzar dos a la vez). */
  findRunning(capabilityId: string, since: Date): Promise<CapabilityTestRun | null>
}

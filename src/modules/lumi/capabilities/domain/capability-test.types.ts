import { z } from 'zod'
import type { TurnTrace } from '../../turn/turn-plan.js'

/**
 * Entorno de pruebas de capacidades (fase D). Una prueba recorre el mismo plan de turno que el
 * chat con los permisos del administrador, pero:
 * - los recordatorios solo se detectan (no se crean);
 * - solo se ejecutan herramientas del catálogo, que son todas de lectura;
 * - no se llama a la conversación con el modelo, no se registran capacidades ni se guarda historial.
 */

/** test: batería; validation: decide si la capacidad pasa; control: solo para el banco, nunca se ejecuta aquí. */
export const PHRASE_ROLES = ['test', 'validation', 'control'] as const
export type PhraseRole = (typeof PHRASE_ROLES)[number]

/** Estado final esperado del turno (los del intérprete del Server). */
export const EXPECTED_STATUSES = [
  'supported',
  'missing_information',
  'missing_capability',
  'ambiguous',
  'delegated',
  'unsupported',
] as const
export type ExpectedStatus = (typeof EXPECTED_STATUSES)[number]

export const PHRASE_LIMIT = 30
export const PHRASE_MAX_CHARS = 500
export const RUN_HISTORY_LIMIT = 20
/** Una ejecución que sigue «en curso» después de esto se da por interrumpida (reinicio del Server). */
export const RUN_STALE_MS = 30 * 60_000
/** Texto de la respuesta guardado por herramienta ejecutada. */
export const EXECUTION_TEXT_MAX = 300
/** Para pasar: al menos este acierto en las frases de validación y todas las críticas. */
export const VALIDATION_THRESHOLD = 0.9

export interface CapabilityPhrase {
  id: string
  capabilityId: string
  text: string
  role: PhraseRole
  expectedStatus: ExpectedStatus
  /** Herramienta esperada (con `supported` o `missing_information`). */
  expectedTool: string | null
  critical: boolean
  createdBy: string
  createdAt: Date
}

export interface ToolExecution {
  tool: string
  denied: boolean
  rows: number | null
  durationMs: number
  /** Respuesta recortada. Las herramientas ya excluyen datos personales de clientes. */
  text: string | null
  error: string | null
}

export interface PhraseResult {
  phraseId: string | null
  text: string
  role: PhraseRole | null
  critical: boolean
  expected: { status: ExpectedStatus; tool: string | null } | null
  actual: { status: string; tool: string | null; reply: 'tools' | 'reply' | 'missing_capability' | 'model' | 'automation' }
  /** null: no había resultado esperado. */
  passed: boolean | null
  /** Recordatorio detectado por reglas (no se ejecuta). */
  automation: string | null
  trace: TurnTrace | null
  executions: ToolExecution[]
  durationMs: number
  error: string | null
}

export interface RunSummary {
  total: number
  evaluated: number
  passed: number
  validation: { total: number; passed: number }
  critical: { total: number; passed: number }
  /** Solo en baterías: null si no hay frases de validación. */
  batteryPassed: boolean | null
}

export type RunStatus = 'running' | 'done' | 'error' | 'interrupted'

export interface CapabilityTestRun {
  id: string
  capabilityId: string
  kind: 'single' | 'battery'
  status: RunStatus
  /** El selector se usó aunque estuviera desactivado en el chat. */
  forceSelector: boolean
  by: string
  results: PhraseResult[]
  summary: RunSummary | null
  error: string | null
  createdAt: Date
  finishedAt: Date | null
}

export const addPhraseSchema = z
  .object({
    text: z.string().trim().min(2).max(PHRASE_MAX_CHARS),
    role: z.enum(PHRASE_ROLES),
    expectedStatus: z.enum(EXPECTED_STATUSES),
    expectedTool: z.string().trim().max(60).nullable().default(null),
    critical: z.boolean().default(false),
  })
  .strict()
export type AddPhraseInput = z.infer<typeof addPhraseSchema>

/** Cambiar una frase sin borrarla: rol, resultado esperado, herramienta y si es crítica. */
export const updatePhraseSchema = z
  .object({
    role: z.enum(PHRASE_ROLES),
    expectedStatus: z.enum(EXPECTED_STATUSES),
    expectedTool: z.string().trim().max(60).nullable(),
    critical: z.boolean(),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update')
export type UpdatePhraseInput = z.infer<typeof updatePhraseSchema>

export const phraseParamsSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{24}$/),
  phraseId: z.string().regex(/^[a-f0-9]{24}$/),
})

export const runParamsSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{24}$/),
  runId: z.string().regex(/^[a-f0-9]{24}$/),
})

export const startRunSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('single'),
      text: z.string().trim().min(2).max(PHRASE_MAX_CHARS),
      expectedStatus: z.enum(EXPECTED_STATUSES).optional(),
      expectedTool: z.string().trim().max(60).optional(),
      forceSelector: z.boolean().default(false),
    })
    .strict(),
  z.object({ kind: z.literal('battery'), forceSelector: z.boolean().default(false) }).strict(),
])
export type StartRunInput = z.infer<typeof startRunSchema>

/** ¿Coincide el resultado con lo esperado? La herramienta solo se compara si se esperaba una. */
export function evaluate(
  expected: { status: ExpectedStatus; tool: string | null } | null,
  actual: { status: string; tool: string | null; tools: readonly string[] },
): boolean | null {
  if (!expected) return null
  if (expected.status !== actual.status) return false
  if (!expected.tool) return true
  return actual.tools.includes(expected.tool) || actual.tool === expected.tool
}

export function summarize(results: readonly PhraseResult[], battery: boolean): RunSummary {
  const evaluated = results.filter((r) => r.passed !== null)
  const validation = results.filter((r) => r.role === 'validation')
  const critical = results.filter((r) => r.critical)
  const summary: RunSummary = {
    total: results.length,
    evaluated: evaluated.length,
    passed: evaluated.filter((r) => r.passed).length,
    validation: { total: validation.length, passed: validation.filter((r) => r.passed).length },
    critical: { total: critical.length, passed: critical.filter((r) => r.passed).length },
    batteryPassed: null,
  }
  if (battery && summary.validation.total > 0) {
    summary.batteryPassed =
      summary.validation.passed / summary.validation.total >= VALIDATION_THRESHOLD &&
      summary.critical.passed === summary.critical.total
  }
  return summary
}

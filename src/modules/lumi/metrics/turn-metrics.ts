import type { Collection, Db } from 'mongodb'
import type { TurnTrace } from '../turn/turn-plan.js'

/**
 * Métricas de turnos de Lumi (fase G): contadores diarios, sin el texto del usuario ni quién
 * preguntó. Responden «¿cuánto resuelve Lumi sin modelo?», «¿cuántas llamadas al selector por cada
 * 100 mensajes?» y «¿cuánto tarda?».
 */

/** Cómo se resolvió el turno. automation: recordatorio por reglas · correction: corrección/confirmación aprendida. */
export const TURN_STAGES = ['automation', 'correction', 'learned', 'rules', 'selector', 'fallback'] as const
export type TurnStage = (typeof TURN_STAGES)[number]

export interface TurnSample {
  stage: TurnStage
  /** Estado final del intérprete (supported, missing_capability…), si lo hubo. */
  interpretation: string | null
  selector?: { outcome: 'ok' | 'disabled' | 'error'; latencyMs?: number; promptTokens?: number; completionTokens?: number; examples?: number }
}

export interface TurnMetricsDay {
  day: string
  turns: number
  stages: Partial<Record<TurnStage, number>>
  interpretations: Record<string, number>
  selectorCalls: number
  selectorErrors: number
  selectorLatencyMsTotal: number
  selectorPromptTokensTotal: number
  selectorCompletionTokensTotal: number
  selectorCallsWithExamples: number
}

export interface TurnMetricsSummary {
  days: number
  from: string
  to: string
  turns: number
  stages: Record<TurnStage, number>
  interpretations: Record<string, number>
  /** Turnos resueltos sin llamar a ningún modelo (recordatorios, correcciones, aprendido, reglas y respuestas fijas). */
  withoutModelRate: number | null
  selectorCalls: number
  selectorCallsPer100: number | null
  selectorErrors: number
  selectorLatencyMsAvg: number | null
  selectorPromptTokensAvg: number | null
  selectorCompletionTokensAvg: number | null
  selectorCallsWithExamples: number
  series: Array<{ day: string; turns: number; selectorCalls: number }>
}

export interface TurnMetricsStore {
  record(sample: TurnSample, at: Date): Promise<void>
  summary(days: number, now: Date): Promise<TurnMetricsSummary>
}

/** Las métricas diarias se guardan 180 días. */
const RETENTION_MS = 180 * 24 * 60 * 60_000
const TIMEZONE = 'America/Bogota'

export function dayKey(at: Date, timeZone = TIMEZONE): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
}

/** Muestra de un turno planificado a partir de su rastro (sin texto). */
export function sampleFromTrace(trace: TurnTrace): TurnSample {
  return {
    stage: trace.stage,
    interpretation: trace.interpretation,
    selector: trace.selector
      ? {
          outcome: trace.selector.outcome,
          latencyMs: trace.selector.latencyMs,
          promptTokens: trace.selector.promptTokens,
          completionTokens: trace.selector.completionTokens,
          examples: trace.examples,
        }
      : undefined,
  }
}

interface MetricsDocument {
  _id: string
  turns: number
  stages: Partial<Record<TurnStage, number>>
  interpretations: Record<string, number>
  selectorCalls: number
  selectorErrors: number
  selectorLatencyMsTotal: number
  selectorPromptTokensTotal: number
  selectorCompletionTokensTotal: number
  selectorCallsWithExamples: number
  expiresAt: Date
}

const INTERPRETATION_KEY = /^[a-z_]{1,40}$/

export class MongoTurnMetrics implements TurnMetricsStore {
  private readonly days: Collection<MetricsDocument>

  constructor(db: Db) {
    this.days = db.collection<MetricsDocument>('lumi_turn_metrics')
  }

  async ensureIndexes(): Promise<void> {
    await this.days.createIndex({ expiresAt: 1 }, { name: 'lumi_turn_metrics_ttl', expireAfterSeconds: 0 })
  }

  async record(sample: TurnSample, at: Date): Promise<void> {
    const inc: Record<string, number> = { turns: 1, [`stages.${sample.stage}`]: 1 }
    if (sample.interpretation && INTERPRETATION_KEY.test(sample.interpretation)) inc[`interpretations.${sample.interpretation}`] = 1
    const sel = sample.selector
    if (sel && sel.outcome !== 'disabled') {
      inc.selectorCalls = 1
      if (sel.outcome === 'error') inc.selectorErrors = 1
      if (sel.outcome === 'ok') {
        inc.selectorLatencyMsTotal = Math.max(0, Math.round(sel.latencyMs ?? 0))
        inc.selectorPromptTokensTotal = Math.max(0, sel.promptTokens ?? 0)
        inc.selectorCompletionTokensTotal = Math.max(0, sel.completionTokens ?? 0)
        if (sel.examples) inc.selectorCallsWithExamples = 1
      }
    }
    await this.days.updateOne(
      { _id: dayKey(at) },
      { $inc: inc, $set: { expiresAt: new Date(at.getTime() + RETENTION_MS) } },
      { upsert: true },
    )
  }

  async summary(days: number, now: Date): Promise<TurnMetricsSummary> {
    const keys = Array.from({ length: days }, (_, i) => dayKey(new Date(now.getTime() - i * 86_400_000)))
    const docs = await this.days.find({ _id: { $in: keys } }).toArray()
    return summarizeDays(docs.map((d) => ({ ...d, day: d._id })), keys)
  }
}

/** Suma los días (función pura, probada sin base de datos). `keys`: días pedidos, del más reciente al más antiguo. */
export function summarizeDays(docs: TurnMetricsDay[], keys: string[]): TurnMetricsSummary {
  const stages = Object.fromEntries(TURN_STAGES.map((s) => [s, 0])) as Record<TurnStage, number>
  const interpretations: Record<string, number> = {}
  let turns = 0
  let selectorCalls = 0
  let selectorErrors = 0
  let latency = 0
  let prompt = 0
  let completion = 0
  let withExamples = 0
  for (const d of docs) {
    turns += d.turns ?? 0
    for (const s of TURN_STAGES) stages[s] += d.stages?.[s] ?? 0
    for (const [k, v] of Object.entries(d.interpretations ?? {})) interpretations[k] = (interpretations[k] ?? 0) + v
    selectorCalls += d.selectorCalls ?? 0
    selectorErrors += d.selectorErrors ?? 0
    latency += d.selectorLatencyMsTotal ?? 0
    prompt += d.selectorPromptTokensTotal ?? 0
    completion += d.selectorCompletionTokensTotal ?? 0
    withExamples += d.selectorCallsWithExamples ?? 0
  }
  const okCalls = selectorCalls - selectorErrors
  // Sin modelo: todo lo que no pasó por el selector ni acabó en conversación con el modelo.
  const modelTurns = stages.selector + stages.fallback
  const byDay = new Map(docs.map((d) => [d.day, d]))
  return {
    days: keys.length,
    from: keys[keys.length - 1] ?? '',
    to: keys[0] ?? '',
    turns,
    stages,
    interpretations,
    withoutModelRate: turns ? (turns - modelTurns) / turns : null,
    selectorCalls,
    selectorCallsPer100: turns ? (100 * selectorCalls) / turns : null,
    selectorErrors,
    selectorLatencyMsAvg: okCalls > 0 ? latency / okCalls : null,
    selectorPromptTokensAvg: okCalls > 0 ? prompt / okCalls : null,
    selectorCompletionTokensAvg: okCalls > 0 ? completion / okCalls : null,
    selectorCallsWithExamples: withExamples,
    series: [...keys].reverse().map((day) => ({ day, turns: byDay.get(day)?.turns ?? 0, selectorCalls: byDay.get(day)?.selectorCalls ?? 0 })),
  }
}

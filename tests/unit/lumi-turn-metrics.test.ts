import { describe, expect, it } from 'vitest'
import { dayKey, sampleFromTrace, summarizeDays, type TurnMetricsDay } from '../../src/modules/lumi/metrics/turn-metrics.js'
import type { TurnTrace } from '../../src/modules/lumi/turn/turn-plan.js'

const trace = (over: Partial<TurnTrace>): TurnTrace => ({
  stage: 'rules', learned: null, rules: null, examples: 0, selector: null, interpretation: 'supported', matches: [],
  pendingTool: null, missing: [], delegate: null, need: null, module: null, ...over,
})

describe('métricas de turnos', () => {
  it('el día es el de la tienda (Bogotá), no el UTC', () => {
    expect(dayKey(new Date('2026-11-16T03:00:00.000Z'))).toBe('2026-11-15')
    expect(dayKey(new Date('2026-11-16T06:00:00.000Z'))).toBe('2026-11-16')
  })

  it('la muestra no lleva texto: solo etapa, estado y números del selector', () => {
    const sample = sampleFromTrace(trace({
      stage: 'selector', interpretation: 'missing_capability', need: 'reseñas negativas', examples: 2,
      selector: { outcome: 'ok', latencyMs: 6000, promptTokens: 1300, completionTokens: 40 },
    }))
    expect(sample).toEqual({
      stage: 'selector', interpretation: 'missing_capability',
      selector: { outcome: 'ok', latencyMs: 6000, promptTokens: 1300, completionTokens: 40, examples: 2 },
    })
    expect(JSON.stringify(sample)).not.toContain('reseñas')
  })

  it('suma días y calcula lo resuelto sin modelo y las llamadas por cada 100 mensajes', () => {
    const day = (d: string, over: Partial<TurnMetricsDay>): TurnMetricsDay => ({
      day: d, turns: 0, stages: {}, interpretations: {}, selectorCalls: 0, selectorErrors: 0, selectorLatencyMsTotal: 0,
      selectorPromptTokensTotal: 0, selectorCompletionTokensTotal: 0, selectorCallsWithExamples: 0, ...over,
    })
    const summary = summarizeDays(
      [
        day('2026-11-15', { turns: 6, stages: { rules: 3, learned: 1, selector: 2 }, interpretations: { supported: 5, missing_capability: 1 }, selectorCalls: 2, selectorLatencyMsTotal: 12_000, selectorPromptTokensTotal: 2600, selectorCompletionTokensTotal: 80, selectorCallsWithExamples: 1 }),
        day('2026-11-14', { turns: 4, stages: { automation: 1, fallback: 2, selector: 1 }, selectorCalls: 2, selectorErrors: 1, selectorLatencyMsTotal: 6000 }),
      ],
      ['2026-11-15', '2026-11-14', '2026-11-13'],
    )
    expect(summary).toMatchObject({
      days: 3, from: '2026-11-13', to: '2026-11-15', turns: 10,
      withoutModelRate: 0.5, selectorCalls: 4, selectorCallsPer100: 40, selectorErrors: 1,
      selectorLatencyMsAvg: 6000, selectorCallsWithExamples: 1,
      interpretations: { supported: 5, missing_capability: 1 },
    })
    expect(summary.stages).toMatchObject({ rules: 3, learned: 1, selector: 3, automation: 1, fallback: 2, correction: 0 })
    expect(summary.series).toEqual([
      { day: '2026-11-13', turns: 0, selectorCalls: 0 },
      { day: '2026-11-14', turns: 4, selectorCalls: 2 },
      { day: '2026-11-15', turns: 6, selectorCalls: 2 },
    ])
  })

  it('sin turnos no inventa porcentajes', () => {
    expect(summarizeDays([], ['2026-11-15'])).toMatchObject({ turns: 0, withoutModelRate: null, selectorCallsPer100: null, selectorLatencyMsAvg: null })
  })
})

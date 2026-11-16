import { describe, expect, it } from 'vitest'
import { AppError } from '../../src/common/errors/app.error.js'
import { EMPTY_SPEC } from '../../src/modules/lumi/capabilities/domain/capability.types.js'
import {
  buildSpecDraftRequest,
  parseSpecDraft,
  READ_PERMISSIONS,
} from '../../src/modules/lumi/capabilities/services/capability-spec-draft.js'
import { LUMI_TOOLS } from '../../src/modules/lumi/tools/catalog.js'

const capability = {
  title: 'Productos de un pedido',
  description: '',
  module: 'pedidos' as const,
  samples: ['que productos tiene este pedido ORD-2026-000046'],
  spec: { ...EMPTY_SPEC, rules: 'Sin datos del cliente.' },
  toolName: null,
}

describe('buildSpecDraftRequest', () => {
  it('fits the assistant limits and includes phrases, written fields, tools and permissions', () => {
    const plan = buildSpecDraftRequest(capability, ['que productos tiene este pedido ORD-2026-000046'], LUMI_TOOLS)
    expect(plan.instructions.length).toBeLessThanOrEqual(2000)
    expect(plan.input.length).toBeLessThanOrEqual(8000)
    expect(plan.maxTokens).toBeLessThanOrEqual(1024)
    // La frase repetida (petición y muestra) aparece una sola vez.
    expect(plan.input.match(/ORD-2026-000046/g)).toHaveLength(1)
    expect(plan.input).toContain('rules: Sin datos del cliente.')
    expect(plan.input).toContain('orders.lookup')
    expect(plan.input).toContain('orders.read')
  })
})

describe('parseSpecDraft', () => {
  it('accepts JSON wrapped in text and keeps only existing permissions and tools', () => {
    const raw = `Aquí está:\n\`\`\`json\n${JSON.stringify({
      expectedResult: 'Lista de productos del pedido con cantidad y precio.',
      parameters: 'reference: referencia del pedido (ORD-...)',
      rules: ['Máximo 30 líneas.', 'Sin datos del cliente.'],
      proposedPermission: 'Orders.Read',
      dataSource: 'Falta: orders.itemsByReference en el repositorio de pedidos',
      relatedTool: 'orders.lookup',
      notes: '',
    })}\n\`\`\``
    const spec = parseSpecDraft(raw, LUMI_TOOLS)
    expect(spec.proposedPermission).toBe('orders.read')
    expect(spec.relatedTool).toBe('orders.lookup')
    expect(spec.rules).toBe('Máximo 30 líneas.\nSin datos del cliente.')
    expect(spec.notes).toBe('')
  })

  it('drops invented permissions and tools and clips long fields', () => {
    const spec = parseSpecDraft(
      JSON.stringify({ expectedResult: 'x'.repeat(5000), proposedPermission: 'orders.items.read', relatedTool: 'orders.items' }),
      LUMI_TOOLS,
    )
    expect(spec.proposedPermission).toBe('')
    expect(spec.relatedTool).toBe('')
    expect(spec.expectedResult).toHaveLength(1000)
    expect(READ_PERMISSIONS).not.toContain('orders.update')
  })

  it('rejects output without JSON or with every field empty', () => {
    expect(() => parseSpecDraft('No sé.', LUMI_TOOLS)).toThrow(AppError)
    expect(() => parseSpecDraft('{"expectedResult": "", "relatedTool": "nope"}', LUMI_TOOLS)).toThrow(AppError)
  })
})

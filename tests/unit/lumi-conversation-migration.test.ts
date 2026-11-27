import { describe, expect, it } from 'vitest'
import {
  conversationExportSchema,
  planImport,
} from '../../src/modules/lumi/conversation/conversation.migration.js'

const REF = { type: 'admin_entity', entity: 'order', id: 'a'.repeat(24), label: 'ORD-1' }
const C1 = '11111111-1111-4111-8111-111111111111'
const C2 = '22222222-2222-4222-8222-222222222222'
const C3 = '33333333-3333-4333-8333-333333333333'

const data = conversationExportSchema.parse({
  format: 1,
  exportedAt: '2026-11-27T15:00:00+00:00',
  skippedWithoutOwner: 1,
  conversations: [
    {
      id: C1,
      userRef: 'u1',
      title: '¿pedidos?',
      createdAt: '2026-11-01T10:00:00+00:00',
      updatedAt: '2026-11-01T10:05:00+00:00',
      messages: [
        {
          role: 'user',
          content: '¿pedidos?',
          references: [],
          createdAt: '2026-11-01T10:00:00+00:00',
        },
        {
          role: 'assistant',
          content: 'Hay 3.',
          references: [REF, { bad: true }],
          createdAt: '2026-11-01T10:00:01+00:00',
        },
      ],
    },
    { id: C2, userRef: 'u1', title: 'vacía', createdAt: null, updatedAt: null, messages: [] },
    {
      id: C3,
      userRef: 'u2',
      title: 'otra',
      createdAt: null,
      updatedAt: null,
      messages: [{ role: 'user', content: 'hola', references: [], createdAt: null }],
    },
  ],
})

describe('migración del historial a MongoDB', () => {
  it('convierte cada conversación y numera sus mensajes en orden', () => {
    const plan = planImport(data, new Map())
    expect(plan.conversations.map((c) => [c._id, c.userId, c.messageCount, c.lastSeq])).toEqual([
      [C1, 'u1', 2, 2],
      [C3, 'u2', 1, 1],
    ])
    const c1 = plan.messages.filter((m) => m.conversationId === C1)
    expect(c1.map((m) => [m.seq, m.role, m.content])).toEqual([
      [1, 'user', '¿pedidos?'],
      [2, 'assistant', 'Hay 3.'],
    ])
    // Solo se conservan referencias válidas.
    expect(c1[1]!.references).toEqual([REF])
    expect(plan.empty).toEqual([C2])
    // Sin fecha, se usa la de la conversación o la de exportación.
    expect(plan.conversations[1]!.createdAt.toISOString()).toBe('2026-11-27T15:00:00.000Z')
  })

  it('es idempotente y no pisa conversaciones distintas', () => {
    const plan = planImport(
      data,
      new Map([
        [C1, { userId: 'u1', messageCount: 2 }],
        [C3, { userId: 'u9', messageCount: 1 }],
      ]),
    )
    expect(plan.conversations).toEqual([])
    expect(plan.messages).toEqual([])
    expect(plan.alreadyImported).toEqual([C1])
    expect(plan.conflicts).toEqual([{ id: C3, reason: 'owned by another user' }])
    const grown = planImport(data, new Map([[C1, { userId: 'u1', messageCount: 4 }]]))
    expect(grown.conflicts).toEqual([{ id: C1, reason: 'has 4 messages, export has 2' }])
  })

  it('rechaza un archivo con otra forma', () => {
    expect(() =>
      conversationExportSchema.parse({ format: 2, exportedAt: 'x', conversations: [] }),
    ).toThrow()
    expect(() =>
      conversationExportSchema.parse({
        format: 1,
        exportedAt: 'x',
        conversations: [
          {
            id: 'no-uuid',
            userRef: 'u1',
            title: '',
            createdAt: null,
            updatedAt: null,
            messages: [],
          },
        ],
      }),
    ).toThrow()
  })
})

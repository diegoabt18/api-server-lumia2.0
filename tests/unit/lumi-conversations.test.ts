import { describe, expect, it } from 'vitest'
import {
  LumiConversationService,
  titleFrom,
} from '../../src/modules/lumi/conversation/conversation.service.js'
import { MemoryConversationStore } from '../../src/modules/lumi/conversation/conversation.store.js'
import type {
  LumiStreamEvent,
  LumiTurnOptions,
} from '../../src/modules/lumi/infrastructure/lumi-assistant.client.js'

const NOW = new Date('2026-11-27T15:00:00.000Z')
const REF = { type: 'admin_entity', entity: 'order', id: 'a'.repeat(24), label: 'ORD-1' } as never

/** IA Assistant sin estado: registra lo que recibe y responde «respuesta N». */
class FakeAssistant {
  calls: Array<{ message: string; conversationId?: string; options: LumiTurnOptions }> = []
  fail = false
  async chat(
    _u: string,
    message: string,
    conversationId?: string,
    _c?: string,
    _w = false,
    options: LumiTurnOptions = {},
  ) {
    this.calls.push({ message, conversationId, options })
    if (this.fail) throw new Error('assistant down')
    return {
      conversationId: conversationId ?? 'ignored',
      model: 'qwen',
      response: `respuesta ${this.calls.length}`,
      references: [REF],
    }
  }
  async *chatStream(
    _u: string,
    message: string,
    conversationId: string | undefined,
    _s: AbortSignal,
    _c?: string,
    _w = false,
    options: LumiTurnOptions = {},
  ): AsyncGenerator<LumiStreamEvent> {
    this.calls.push({ message, conversationId, options })
    yield { type: 'start', conversationId: conversationId ?? 'x' }
    yield { type: 'token', text: 'hola ' }
    if (this.fail) {
      yield { type: 'error', message: 'falló' }
      return
    }
    yield { type: 'token', text: 'mundo' }
    yield { type: 'references', references: [REF] }
    yield { type: 'done', conversationId: conversationId ?? 'x' }
  }
}

function setup() {
  const store = new MemoryConversationStore()
  const assistant = new FakeAssistant()
  const service = new LumiConversationService(store, assistant as never, () => NOW, 4)
  return { store, assistant, service }
}

const collect = async (events: AsyncGenerator<LumiStreamEvent>) => {
  const out: LumiStreamEvent[] = []
  for await (const e of events) out.push(e)
  return out
}

describe('conversaciones de Lumi en el Server', () => {
  it('crea la conversación, guarda el turno y lo reutiliza como historial del siguiente', async () => {
    const { service, assistant } = setup()
    const first = await service.chat('u1', '¿cuántos pedidos hay?')
    expect(first.response).toBe('respuesta 1')
    await service.chat('u1', '¿y el más antiguo?', first.conversationId)
    expect(assistant.calls[0]!.options).toMatchObject({ history: [], persist: false })
    expect(assistant.calls[1]!.options.history).toEqual([
      { role: 'user', content: '¿cuántos pedidos hay?' },
      { role: 'assistant', content: 'respuesta 1' },
    ])
    expect(assistant.calls[1]!.conversationId).toBe(first.conversationId)
    const detail = await service.getConversation('u1', first.conversationId)
    expect(detail.title).toBe('¿cuántos pedidos hay?')
    expect(detail.messages.map((m) => [m.id, m.role])).toEqual([
      [1, 'user'],
      [2, 'assistant'],
      [3, 'user'],
      [4, 'assistant'],
    ])
    expect(detail.messages[1]!.references).toEqual([REF])
  })

  it('el historial que recibe el modelo se limita a los últimos turnos', async () => {
    const { service, assistant } = setup()
    const { conversationId } = await service.chat('u1', 'uno')
    await service.chat('u1', 'dos', conversationId)
    await service.chat('u1', 'tres', conversationId)
    expect(assistant.calls[2]!.options.history!.map((m) => m.content)).toEqual(
      ['uno', 'respuesta 1', 'dos', 'respuesta 2'].slice(-4),
    )
  })

  it('la conversación de otro usuario no existe para él', async () => {
    const { service } = setup()
    const { conversationId } = await service.chat('u1', 'hola')
    await expect(service.chat('u2', 'hola', conversationId)).rejects.toMatchObject({
      statusCode: 404,
    })
    await expect(service.getConversation('u2', conversationId)).rejects.toMatchObject({
      statusCode: 404,
    })
    await expect(service.deleteConversation('u2', conversationId)).rejects.toMatchObject({
      statusCode: 404,
    })
    expect(await service.listConversations('u2', 50, 0)).toEqual([])
  })

  it('un reintento con el mismo clientMessageId devuelve la respuesta guardada sin repetir el turno', async () => {
    const { service, assistant } = setup()
    const a = await service.chat('u1', 'hola', undefined, undefined, false, {
      clientMessageId: 'msg-00000001',
    })
    const b = await service.chat('u1', 'hola', a.conversationId, undefined, false, {
      clientMessageId: 'msg-00000001',
    })
    expect(b).toMatchObject({
      conversationId: a.conversationId,
      response: a.response,
      model: 'lumi-replay',
    })
    expect(assistant.calls).toHaveLength(1)
    expect((await service.getConversation('u1', a.conversationId)).messages).toHaveLength(2)
  })

  it('un mismo mensaje en curso responde 409 en lugar de duplicarse', async () => {
    const { service, store } = setup()
    const { conversationId } = await service.chat('u1', 'primero')
    await store.claim('u1', conversationId, 'msg-00000009', NOW)
    await expect(
      service.chat('u1', 'segundo', conversationId, undefined, false, {
        clientMessageId: 'msg-00000009',
      }),
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  it('si el asistente falla, no se guarda nada y el mensaje se puede reintentar', async () => {
    const { service, assistant } = setup()
    const { conversationId } = await service.chat('u1', 'primero')
    assistant.fail = true
    await expect(
      service.chat('u1', 'segundo', conversationId, undefined, false, {
        clientMessageId: 'msg-00000002',
      }),
    ).rejects.toThrow('assistant down')
    assistant.fail = false
    const retry = await service.chat('u1', 'segundo', conversationId, undefined, false, {
      clientMessageId: 'msg-00000002',
    })
    expect(retry.model).toBe('qwen')
    expect((await service.getConversation('u1', conversationId)).messages).toHaveLength(4)
  })

  it('el streaming se guarda al terminar, con el texto completo y sus referencias', async () => {
    const { service } = setup()
    const events = await collect(
      service.chatStream('u1', 'hola', undefined, new AbortController().signal),
    )
    const done = events.at(-1) as { type: 'done'; conversationId: string }
    expect(done.type).toBe('done')
    expect(events[0]).toEqual({ type: 'start', conversationId: done.conversationId })
    const detail = await service.getConversation('u1', done.conversationId)
    expect(detail.messages[1]).toMatchObject({ content: 'hola mundo', references: [REF] })
  })

  it('un streaming que falla o se corta no se guarda y libera el mensaje', async () => {
    const { service, assistant, store } = setup()
    assistant.fail = true
    await collect(
      service.chatStream('u1', 'hola', undefined, new AbortController().signal, undefined, false, {
        clientMessageId: 'msg-00000003',
      }),
    )
    expect(await service.listConversations('u1', 50, 0)).toEqual([])
    // Desconexión del cliente a mitad: se abandona el generador.
    assistant.fail = false
    const { conversationId } = await service.chat('u1', 'base')
    const stream = service.chatStream(
      'u1',
      'otra',
      conversationId,
      new AbortController().signal,
      undefined,
      false,
      {
        clientMessageId: 'msg-00000004',
      },
    )
    await stream.next()
    await stream.return(undefined)
    expect((await store.claim('u1', conversationId, 'msg-00000004', NOW)).kind).toBe('claimed')
    expect((await service.getConversation('u1', conversationId)).messages).toHaveLength(2)
  })

  it('un reintento en streaming de un turno terminado lo devuelve sin llamar al modelo', async () => {
    const { service, assistant } = setup()
    const first = await service.chat('u1', 'hola', undefined, undefined, false, {
      clientMessageId: 'msg-00000005',
    })
    const events = await collect(
      service.chatStream(
        'u1',
        'hola',
        first.conversationId,
        new AbortController().signal,
        undefined,
        false,
        {
          clientMessageId: 'msg-00000005',
        },
      ),
    )
    expect(events.filter((e) => e.type === 'token')).toEqual([
      { type: 'token', text: first.response },
    ])
    expect(assistant.calls).toHaveLength(1)
  })

  it('los turnos sin modelo se guardan igual y listar ordena por actividad', async () => {
    const { service } = setup()
    const a = await service.recordExchange('u1', 'recuérdame algo', 'Listo.', undefined, [REF])
    const b = await service.recordExchange('u1', 'otra cosa', 'Hecho.')
    const list = await service.listConversations('u1', 50, 0)
    expect(list.map((c) => c.id).sort()).toEqual([a.conversationId, b.conversationId].sort())
    expect(list[0]).toMatchObject({ messageCount: 2 })
    await service.deleteConversation('u1', a.conversationId)
    expect((await service.listConversations('u1', 50, 0)).map((c) => c.id)).toEqual([
      b.conversationId,
    ])
  })

  it('sin asistente configurado el historial funciona y el chat responde 503', async () => {
    const store = new MemoryConversationStore()
    const service = new LumiConversationService(store, null, () => NOW)
    const { conversationId } = await service.recordExchange('u1', 'hola', 'respuesta')
    expect((await service.getConversation('u1', conversationId)).messages).toHaveLength(2)
    await expect(service.chat('u1', 'hola', conversationId)).rejects.toMatchObject({
      statusCode: 503,
    })
  })

  it('el título se calcula como en la IA Assistant', () => {
    expect(titleFrom('  hola   mundo  ')).toBe('hola mundo')
    expect(titleFrom('a'.repeat(200))).toHaveLength(60)
    expect(titleFrom('   ')).toBe('Nueva conversación')
  })
})

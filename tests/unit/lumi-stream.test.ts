import { describe, expect, it, vi } from 'vitest'
import { AppError } from '../../src/common/errors/app.error.js'
import {
  LumiAssistantClient,
  type LumiStreamEvent,
  parseSseBlock,
  splitSseBuffer,
  toLumiStreamEvent,
} from '../../src/modules/lumi/infrastructure/lumi-assistant.client.js'

const USER = '65f1c0ffee0000000000abcd'
const BASE = 'http://127.0.0.1:8000'

/** Cuerpo SSE que se entrega en trozos arbitrarios, como lo haría la red. */
function streamOf(chunks: string[]): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

async function collect(gen: AsyncGenerator<LumiStreamEvent>): Promise<LumiStreamEvent[]> {
  const out: LumiStreamEvent[] = []
  for await (const event of gen) out.push(event)
  return out
}

describe('SSE framing', () => {
  it('keeps an incomplete trailing block for the next chunk', () => {
    const { blocks, rest } = splitSseBuffer('event: token\ndata: {"text":"a"}\n\nevent: tok')
    expect(blocks).toEqual(['event: token\ndata: {"text":"a"}'])
    expect(rest).toBe('event: tok')
  })

  it('joins multi-line data fields and ignores comments', () => {
    expect(parseSseBlock(': keep-alive\nevent: token\ndata: {"text":\ndata: "x"}')).toEqual({
      event: 'token',
      data: '{"text":\n"x"}',
    })
  })
})

describe('toLumiStreamEvent', () => {
  it('maps assistant events to the Lumi contract in camelCase', () => {
    expect(toLumiStreamEvent('start', '{"conversation_id":"c-1"}')).toEqual({
      type: 'start',
      conversationId: 'c-1',
    })
    expect(toLumiStreamEvent('token', '{"text":"Hola"}')).toEqual({ type: 'token', text: 'Hola' })
    expect(toLumiStreamEvent('done', '{"conversation_id":"c-1","sources":[]}')).toEqual({
      type: 'done',
      conversationId: 'c-1',
    })
  })

  it('ignores unknown events and malformed payloads', () => {
    expect(toLumiStreamEvent('sources', '{"sources":[]}')).toBeNull()
    expect(toLumiStreamEvent('token', '{"other":1}')).toBeNull()
    expect(toLumiStreamEvent('token', 'no json')).toBeNull()
  })

  it('replaces upstream error details with a generic message', () => {
    expect(
      toLumiStreamEvent('error', '{"detail":"Error en el servicio Ollama: 127.0.0.1:11434"}'),
    ).toEqual({
      type: 'error',
      message: 'El asistente Lumi no pudo completar la respuesta.',
    })
  })
})

describe('LumiAssistantClient.chatStream', () => {
  it('yields events even when they arrive split across chunks', async () => {
    const fetchImpl = vi.fn(async () =>
      streamOf([
        'event: start\ndata: {"conversation_id":"c-1"}\n\nevent: tok',
        'en\ndata: {"text":"Hola"}\n\nevent: token\ndata: {"text":" mundo"}\n\n',
        'event: sources\ndata: {"sources":[]}\n\nevent: done\ndata: {"conversation_id":"c-1","sources":[]}\n\n',
      ]),
    )
    const client = new LumiAssistantClient({
      baseUrl: BASE,
      apiKey: 'clave-de-servicio-larga',
      timeoutMs: 5000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const events = await collect(
      client.chatStream(USER, 'hola', undefined, new AbortController().signal),
    )

    expect(events).toEqual([
      { type: 'start', conversationId: 'c-1' },
      { type: 'token', text: 'Hola' },
      { type: 'token', text: ' mundo' },
      { type: 'done', conversationId: 'c-1' },
    ])
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${BASE}/api/v1/chat/stream`)
    expect(JSON.parse(String(init.body))).toEqual({
      message: 'hola',
      conversation_id: null,
      use_web: false,
    })
  })

  it('reports a missing conversation before any event is produced', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"detail":"no"}', { status: 404 }))
    const client = new LumiAssistantClient({
      baseUrl: BASE,
      apiKey: 'clave-de-servicio-larga',
      timeoutMs: 5000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await expect(
      collect(
        client.chatStream(
          USER,
          'hola',
          '11111111-2222-3333-4444-555555555555',
          new AbortController().signal,
        ),
      ),
    ).rejects.toMatchObject({ statusCode: 404 })
  })

  it('stops reading when the caller aborts', async () => {
    const encoder = new TextEncoder()
    let pushed = false
    const fetchImpl = vi.fn(
      async (_url: string, init: RequestInit) =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (!pushed) {
                pushed = true
                controller.enqueue(encoder.encode('event: token\ndata: {"text":"a"}\n\n'))
                return undefined
              }
              return new Promise<void>((_resolve, reject) => {
                init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
              })
            },
          }),
          { status: 200 },
        ),
    )
    const client = new LumiAssistantClient({
      baseUrl: BASE,
      apiKey: 'clave-de-servicio-larga',
      timeoutMs: 5000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const controller = new AbortController()
    const seen: LumiStreamEvent[] = []
    const run = (async () => {
      for await (const event of client.chatStream(USER, 'hola', undefined, controller.signal)) {
        seen.push(event)
        controller.abort()
      }
    })()
    await expect(run).rejects.toThrow()
    expect(seen).toEqual([{ type: 'token', text: 'a' }])
  })

  it('refuses malformed user references before opening a connection', async () => {
    const fetchImpl = vi.fn()
    const client = new LumiAssistantClient({
      baseUrl: BASE,
      apiKey: 'clave-de-servicio-larga',
      timeoutMs: 5000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const err = await collect(
      client.chatStream('../x', 'hola', undefined, new AbortController().signal),
    ).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AppError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

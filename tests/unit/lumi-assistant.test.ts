import { describe, expect, it, vi } from 'vitest'
import { AppError } from '../../src/common/errors/app.error.js'
import { LumiAssistantClient } from '../../src/modules/lumi/infrastructure/lumi-assistant.client.js'

const USER = '65f1c0ffee0000000000abcd'
const BASE = 'http://127.0.0.1:8000'

function clientWith(fetchImpl: typeof fetch) {
  return new LumiAssistantClient({
    baseUrl: BASE,
    apiKey: 'clave-de-servicio-larga',
    timeoutMs: 5000,
    fetchImpl,
  })
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function captureError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise
  } catch (err) {
    if (err instanceof AppError) return err
    throw err
  }
  throw new Error('expected AppError')
}

describe('LumiAssistantClient', () => {
  it('sends the service key, the user reference and never enables web search', async () => {
    const fetchImpl = vi.fn(async () =>
      json(200, { conversation_id: 'c-1', model: 'qwen', response: 'Hola', sources: [] }),
    )
    const result = await clientWith(fetchImpl as unknown as typeof fetch).chat(USER, 'hola')

    expect(result).toEqual({ conversationId: 'c-1', model: 'qwen', response: 'Hola' })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${BASE}/api/v1/chat`)
    const headers = init.headers as Record<string, string>
    expect(headers['X-API-Key']).toBe('clave-de-servicio-larga')
    expect(headers['X-User-Ref']).toBe(USER)
    expect(JSON.parse(String(init.body))).toEqual({
      message: 'hola',
      conversation_id: null,
      use_web: false,
    })
  })

  it('refuses an invalid user reference before calling the assistant', async () => {
    const fetchImpl = vi.fn()
    const err = await captureError(
      clientWith(fetchImpl as unknown as typeof fetch).chat('../otro', 'hola'),
    )
    expect(err.statusCode).toBe(400)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reports unavailability when the assistant cannot be reached', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    const err = await captureError(
      clientWith(fetchImpl as unknown as typeof fetch).chat(USER, 'hola'),
    )
    expect(err.statusCode).toBe(503)
    expect(err.code).toBe('LUMI_UNAVAILABLE')
  })

  it('does not leak assistant internals on upstream failures', async () => {
    const fetchImpl = vi.fn(async () =>
      json(502, { detail: 'Error en el servicio Ollama: connection refused 127.0.0.1:11434' }),
    )
    const err = await captureError(
      clientWith(fetchImpl as unknown as typeof fetch).chat(USER, 'hola'),
    )
    expect(err.statusCode).toBe(502)
    expect(err.message).not.toContain('11434')
  })

  it('maps a missing conversation to not found', async () => {
    const fetchImpl = vi.fn(async () => json(404, { detail: 'Conversación no encontrada' }))
    const err = await captureError(
      clientWith(fetchImpl as unknown as typeof fetch).getConversation(
        USER,
        '11111111-2222-3333-4444-555555555555',
      ),
    )
    expect(err.statusCode).toBe(404)
  })

  it('rejects unexpected upstream payloads instead of forwarding them', async () => {
    const fetchImpl = vi.fn(async () => json(200, { unexpected: true }))
    await expect(
      clientWith(fetchImpl as unknown as typeof fetch).chat(USER, 'hola'),
    ).rejects.toThrow()
  })

  it('maps usage to camelCase and passes the window to the assistant', async () => {
    const fetchImpl = vi.fn(async () =>
      json(200, { days: 7, requests: 3, prompt_tokens: 120, completion_tokens: 40 }),
    )
    const usage = await clientWith(fetchImpl as unknown as typeof fetch).usage(USER, 7)
    expect(usage).toEqual({ days: 7, requests: 3, promptTokens: 120, completionTokens: 40 })
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe(`${BASE}/api/v1/usage?days=7`)
  })

  it('treats a 204 delete as success', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }))
    await expect(
      clientWith(fetchImpl as unknown as typeof fetch).deleteConversation(USER, 'c-1'),
    ).resolves.toBeUndefined()
  })
})

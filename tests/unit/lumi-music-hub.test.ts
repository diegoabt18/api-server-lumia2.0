import { describe, expect, it } from 'vitest'
import { lumiMusicPlayerCommandSchema, lumiMusicSearchQuerySchema } from '../../src/modules/lumi/schemas/lumi.schema.js'
import { LumiAssistantClient } from '../../src/modules/lumi/infrastructure/lumi-assistant.client.js'
import { LumiMusicHub, type LumiMusicHubEvent } from '../../src/modules/lumi/infrastructure/lumi-music-hub.js'

const RAW_STATE = {
  status: 'playing',
  generation: 2,
  current: { video_id: '8LDOUFJVNmg', title: 'Conspiracy', artist: 'Paramore', duration_seconds: 223 },
  upcoming: [],
  position_seconds: 10,
  duration_seconds: 223,
  volume: 60,
  output: { mode: 'aux', sink: 'alsa_output.x' },
  error: null,
  shuffle: true,
  repeat_mode: 'all',
  autoplay: true,
  version: 7,
  updated_at: 1_763_500_000_000,
}

/** Respuesta SSE controlable: cada push envía un bloque; end() cierra el stream. */
function sseResponse() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({ start: (c) => (controller = c) })
  const encoder = new TextEncoder()
  return {
    response: new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    push: (event: string, data: unknown) => controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)),
    end: () => controller.close(),
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

describe('LumiMusicHub', () => {
  it('shares one upstream connection, replays the last state and closes with the last subscriber', async () => {
    const streams: ReturnType<typeof sseResponse>[] = []
    const signals: AbortSignal[] = []
    const hub = new LumiMusicHub({
      musicEvents: async (signal) => {
        signals.push(signal)
        const stream = sseResponse()
        streams.push(stream)
        return stream.response
      },
    })
    const a: LumiMusicHubEvent[] = []
    const b: LumiMusicHubEvent[] = []
    const offA = hub.subscribe((e) => a.push(e))
    await tick()
    streams[0]!.push('state', RAW_STATE)
    streams[0]!.push('state', { broken: true }) // forma inesperada: se ignora
    await tick()
    const offB = hub.subscribe((e) => b.push(e))
    expect(streams).toHaveLength(1) // una sola conexión para las dos pestañas
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1) // el nuevo recibe al momento el último estado
    const first = a[0]
    expect(first?.type === 'state' && first.state).toMatchObject({ status: 'playing', shuffle: true, repeatMode: 'all', autoplay: true, version: 7 })
    expect(JSON.stringify(a)).not.toContain('alsa_output')
    offA()
    expect(signals[0]!.aborted).toBe(false)
    offB()
    expect(signals[0]!.aborted).toBe(true)
    expect(hub.connected).toBe(false)
  })

  it('reports the assistant as unavailable once and reconnects while someone listens', async () => {
    let calls = 0
    const hub = new LumiMusicHub(
      {
        musicEvents: async () => {
          calls += 1
          return calls === 1 ? null : new Response('no', { status: 404 })
        },
      },
      undefined,
      [1, 1],
    )
    const events: LumiMusicHubEvent[] = []
    const off = hub.subscribe((e) => events.push(e))
    await tick()
    await tick()
    expect(calls).toBeGreaterThanOrEqual(2)
    expect(events[0]).toEqual({ type: 'unavailable', reason: 'unavailable' })
    expect(events).toContainEqual({ type: 'unavailable', reason: 'disabled' })
    off()
    const after = calls
    await tick()
    expect(calls).toBe(after) // sin suscriptores no se reintenta
  })
})

describe('contratos del centro de música', () => {
  it('accepts only closed player commands', () => {
    const ok = (body: unknown) => lumiMusicPlayerCommandSchema.safeParse(body).success
    expect(ok({ tool: 'music.play', args: { video_id: '8LDOUFJVNmg' } })).toBe(true)
    expect(ok({ tool: 'music.play' })).toBe(true)
    expect(ok({ tool: 'music.enqueue', args: { video_id: '8LDOUFJVNmg' } })).toBe(true)
    expect(ok({ tool: 'music.move', args: { position: 2, to: 1 } })).toBe(true)
    expect(ok({ tool: 'music.repeat', args: { repeat: 'one' } })).toBe(true)
    expect(ok({ tool: 'music.shuffle', args: { state: 'on' } })).toBe(true)
    expect(ok({ tool: 'music.enqueue', args: { query: 'algo' } })).toBe(false) // nada de búsquedas libres
    expect(ok({ tool: 'music.play', args: { video_id: 'https://evil.example/x' } })).toBe(false)
    expect(ok({ tool: 'music.remove', args: { position: 0 } })).toBe(false)
    expect(ok({ tool: 'music.autoplay', args: { state: 'maybe' } })).toBe(false)
    expect(lumiMusicSearchQuerySchema.safeParse({ q: '  ' }).success).toBe(false)
  })

  it('reads recommendations and drops unexpected thumbnails', async () => {
    const calls: string[] = []
    const client = new LumiAssistantClient(
    {
      baseUrl: 'http://assistant',
      apiKey: 'k',
      timeoutMs: 1000,
      fetchImpl: async (url) => {
        calls.push(String(url))
        return new Response(
          JSON.stringify({
            seed: null,
            tracks: [{ video_id: 'RvnkAtWcKYg', title: 'Decode', artist: 'Paramore', thumbnail_url: 'https://evil.example/x.jpg' }],
            artist_tracks: [],
            artists: [{ name: 'Hayley Williams', tracks: 2 }],
          }),
          { status: 200 },
        )
      },
    })
    const result = await client.musicRecommendations('user-1', 'RvnkAtWcKYg')
    expect(calls[0]).toBe('http://assistant/api/v1/music/recommendations?video_id=RvnkAtWcKYg')
    expect(result.status === 'done' && result.data.tracks[0]).toMatchObject({ videoId: 'RvnkAtWcKYg', thumbnailUrl: null })
    expect(result.status === 'done' && result.data.artists).toEqual([{ name: 'Hayley Williams', tracks: 2 }])
  })
})

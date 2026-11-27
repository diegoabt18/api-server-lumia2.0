import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  PERMISSION_REGISTRY as P,
  type PermissionId,
} from '../../src/common/permissions/registry.js'
import type { DesktopDevice } from '../../src/modules/lumi/desktop-agent/domain/device.js'
import {
  DESKTOP_OPERATIONS,
  canonicalYoutubeVideoUrl,
} from '../../src/modules/lumi/desktop-agent/domain/operations.js'
import {
  taskStatePayloadSchema,
  type Envelope,
  type TaskStage,
} from '../../src/modules/lumi/desktop-agent/domain/protocol.js'
import { MemoryDesktopDeviceStore } from '../../src/modules/lumi/desktop-agent/infrastructure/desktop-device.repository.js'
import { MemoryDesktopExecutionStore } from '../../src/modules/lumi/desktop-agent/infrastructure/desktop-execution.repository.js'
import { GrantSigner } from '../../src/modules/lumi/desktop-agent/infrastructure/grant-signer.js'
import {
  DesktopExecutionService,
  type TaskTransport,
} from '../../src/modules/lumi/desktop-agent/services/execution.service.js'
import { MusicCandidatesStore } from '../../src/modules/lumi/music/candidates-store.js'
import {
  selectMusicCandidate,
  type MusicPlaybackEvent,
} from '../../src/modules/lumi/music/music-selection.js'
import {
  parseVideoLabel,
  type MusicPlaybackOutcome,
} from '../../src/modules/lumi/tools/desktop.tools.js'
import {
  KIND_RANK,
  isFullMatch,
  matchVideo,
  videoKind,
} from '../../src/modules/lumi/music/video-match.js'
import {
  MusicPlaybackMachine,
  STAGE_STATE,
  errorState,
} from '../../src/modules/lumi/music/playback-state.js'
import type {
  LumiMusicSelection,
  LumiToolContext,
} from '../../src/modules/lumi/tools/tool.types.js'

/* ───────────────────────── Máquina de estados ───────────────────────── */

describe('reproducción de música: máquina de estados', () => {
  it('recorre el camino completo hacia delante', () => {
    const m = new MusicPlaybackMachine()
    for (const s of [
      'VALIDATED',
      'BROWSER_READY',
      'TAB_READY',
      'NAVIGATING',
      'NAVIGATION_COMPLETED',
      'PLAYING',
      'MINIMIZING',
      'COMPLETED',
    ] as const) {
      expect(m.advance(s), s).toBe(true)
    }
    expect(m.state).toBe('COMPLETED')
  })

  it('rechaza transiciones hacia atrás, repetidas o tras un estado final', () => {
    const m = new MusicPlaybackMachine()
    m.advance('NAVIGATING')
    expect(m.advance('NAVIGATING')).toBe(false)
    expect(m.advance('BROWSER_READY')).toBe(false)
    expect(m.advance('VIDEO_UNAVAILABLE')).toBe(true)
    expect(m.advance('PLAYING')).toBe(false)
    expect(m.state).toBe('VIDEO_UNAVAILABLE')
  })

  it('no confirma COMPLETED ni minimiza sin reproducción confirmada', () => {
    const m = new MusicPlaybackMachine()
    m.advance('NAVIGATION_COMPLETED')
    expect(m.advance('MINIMIZING')).toBe(false)
    expect(m.advance('COMPLETED')).toBe(false)
    expect(m.advance('MINIMIZE_FAILED')).toBe(false)
    expect(m.advance('PLAYING')).toBe(true)
    expect(m.advance('COMPLETED')).toBe(false)
    expect(m.advance('MINIMIZE_FAILED')).toBe(true)
    expect(m.advance('COMPLETED')).toBe(false)
  })

  it('un resultado final puede confirmar pasos que no llegaron (reconexión)', () => {
    const m = new MusicPlaybackMachine()
    m.advance('NAVIGATING')
    expect(m.advance('PLAYING')).toBe(true)
    expect(m.advance('MINIMIZING')).toBe(true)
    expect(m.advance('COMPLETED')).toBe(true)
  })

  it('traduce los pasos y los códigos del agente', () => {
    expect(STAGE_STATE['tab.created']).toBe('TAB_READY')
    expect(STAGE_STATE['browser.minimize_failed']).toBe('MINIMIZE_FAILED')
    expect(errorState('PLAYBACK_BLOCKED')).toBe('PLAYBACK_BLOCKED')
    expect(errorState('OPERATION_TIMEOUT')).toBe('EXECUTION_TIMEOUT')
    expect(errorState('NO_RESULT')).toBe('EXECUTION_TIMEOUT')
    expect(errorState('BROWSER_LAUNCH_FAILED')).toBe('BROWSER_UNAVAILABLE')
    expect(errorState('DEVICE_OFFLINE')).toBe('BROWSER_UNAVAILABLE')
  })
})

/* ───────────────────────── Catálogo y protocolo ───────────────────────── */

describe('browser.media.play: solo un vídeo de YouTube validado', () => {
  it('canonicaliza la URL y rechaza todo lo demás', () => {
    expect(
      canonicalYoutubeVideoUrl('https://www.youtube.com/watch?v=kXYiU_JCYtU&list=RD1&pp=ygU'),
    ).toBe('https://www.youtube.com/watch?v=kXYiU_JCYtU')
    expect(canonicalYoutubeVideoUrl('https://m.youtube.com/watch?v=kXYiU_JCYtU')).toBe(
      'https://www.youtube.com/watch?v=kXYiU_JCYtU',
    )
    for (const bad of [
      'http://www.youtube.com/watch?v=kXYiU_JCYtU',
      'https://www.youtube.com.evil.com/watch?v=kXYiU_JCYtU',
      'https://www.youtube.com/results?search_query=x',
      'https://www.youtube.com/watch?v=short',
      'https://www.youtube.com:444/watch?v=kXYiU_JCYtU',
      'https://u:p@www.youtube.com/watch?v=kXYiU_JCYtU',
      'javascript:alert(1)',
      undefined,
      42,
    ]) {
      expect(canonicalYoutubeVideoUrl(bad), String(bad)).toBeNull()
    }
  })

  it('el esquema solo acepta la URL canónica, sin campos extra', () => {
    const op = DESKTOP_OPERATIONS['browser.media.play']!
    expect(op.permission).toBe(P.DESKTOP_BROWSER_CONTROL)
    expect(op.args.safeParse({ url: 'https://www.youtube.com/watch?v=kXYiU_JCYtU' }).success).toBe(
      true,
    )
    expect(
      op.args.safeParse({ url: 'https://www.youtube.com/watch?v=kXYiU_JCYtU&list=x' }).success,
    ).toBe(false)
    expect(
      op.args.safeParse({ url: 'https://www.youtube.com/watch?v=kXYiU_JCYtU', script: '1' })
        .success,
    ).toBe(false)
    expect(op.summarize({ url: 'https://www.youtube.com/watch?v=kXYiU_JCYtU' })).toEqual({
      video: 'kXYiU_JCYtU',
      minimize: true,
    })
  })

  it('task.state acepta solo pasos conocidos', () => {
    expect(
      taskStatePayloadSchema.safeParse({ state: 'running', stage: 'playback.started' }).success,
    ).toBe(true)
    expect(taskStatePayloadSchema.safeParse({ state: 'running' }).success).toBe(true)
    expect(taskStatePayloadSchema.safeParse({ state: 'running', stage: 'rm -rf' }).success).toBe(
      false,
    )
  })
})

/* ───────────────────────── Correlación de pasos ───────────────────────── */

const DEVICE = 'dev_0123456789abcdef01234567'
const OTHER = 'dev_fedcba9876543210fedcba98'

class FakeTransport implements TaskTransport {
  sent: Array<{ deviceId: string; type: string; taskId: string }> = []
  isOnline() {
    return true
  }
  sendTask(deviceId: string, type: string, taskId: string) {
    this.sent.push({ deviceId, type, taskId })
    return true
  }
}

function device(id: string): DesktopDevice {
  return {
    id,
    ownerUserId: 'owner',
    installationId: randomUUID(),
    publicKey: (id === DEVICE ? 'x' : 'y').repeat(43),
    name: 'PC',
    os: 'windows',
    osVersion: '10.0.26200',
    arch: 'x86_64',
    agentVersion: '0.3.0',
    status: 'active',
    execution: 'active',
    capabilities: {
      engines: {
        browser: { available: true, reason: null },
        desktop: { available: false, reason: 'x' },
      },
      operations: ['browser.media.play'],
    },
    registeredAt: new Date(),
    revokedAt: null,
    lastSeenAt: new Date(),
  }
}

function message(
  type: string,
  from: string,
  taskId: string,
  payload: Record<string, unknown>,
): Envelope {
  return {
    protocol_version: '1.2',
    message_id: randomUUID(),
    message_type: type,
    timestamp: new Date().toISOString(),
    device_id: from,
    task_id: taskId,
    payload,
  }
}

describe('pasos de una ejecución: solo para el despacho que la originó', () => {
  it('entrega los pasos en orden e ignora los de otro equipo o tras el resultado', async () => {
    const devices = new MemoryDesktopDeviceStore()
    await devices.insert(device(DEVICE))
    await devices.insert(device(OTHER))
    const transport = new FakeTransport()
    const service = new DesktopExecutionService({
      devices,
      executions: new MemoryDesktopExecutionStore(),
      signer: new GrantSigner(Buffer.alloc(32, 7)),
      transport,
    })
    const stages: TaskStage[] = []
    const done = service.dispatch({
      userId: 'owner',
      permissionKeys: ['*'] as unknown as PermissionId[],
      deviceId: DEVICE,
      operation: 'browser.media.play',
      args: { url: 'https://www.youtube.com/watch?v=kXYiU_JCYtU' },
      onStage: (s) => stages.push(s),
    })
    await vi.waitFor(() =>
      expect(transport.sent.some((s) => s.type === 'task.dispatch')).toBe(true),
    )
    const taskId = transport.sent.find((s) => s.type === 'task.dispatch')!.taskId

    await service.onAgentMessage(
      DEVICE,
      message('task.state', DEVICE, taskId, { state: 'running', stage: 'browser.ready' }),
    )
    // Otro equipo no puede informar pasos de esta tarea.
    await service.onAgentMessage(
      OTHER,
      message('task.state', OTHER, taskId, { state: 'running', stage: 'playback.started' }),
    )
    // Un paso desconocido se descarta entero.
    await service.onAgentMessage(
      DEVICE,
      message('task.state', DEVICE, taskId, { state: 'running', stage: 'hacked' }),
    )
    await service.onAgentMessage(
      DEVICE,
      message('task.state', DEVICE, taskId, { state: 'running', stage: 'playback.started' }),
    )
    await service.onAgentMessage(
      DEVICE,
      message('task.result', DEVICE, taskId, {
        status: 'completed',
        operation: 'browser.media.play',
        verification: { verified: true, method: 'browser.media_playback' },
        result: { state: 'COMPLETED' },
        error: null,
        duration_ms: 5000,
      }),
    )
    const out = await done
    // Llega tarde: la tarea ya terminó.
    await service.onAgentMessage(
      DEVICE,
      message('task.state', DEVICE, taskId, { state: 'running', stage: 'browser.minimized' }),
    )
    expect(stages).toEqual(['browser.ready', 'playback.started'])
    expect(out.execution.status).toBe('completed')
    expect(out.execution.argsSummary).toEqual({ video: 'kXYiU_JCYtU', minimize: true })
  })
})

/* ───────────────────────── Búsquedas guardadas ───────────────────────── */

function selection(): LumiMusicSelection {
  return {
    queryId: randomUUID(),
    query: 'numb',
    deviceId: DEVICE,
    deviceName: 'PC',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    candidates: [],
  }
}

describe('búsquedas de música: conversación y reproducción ya hecha', () => {
  it('liga la búsqueda a su conversación una sola vez', async () => {
    const store = new MusicCandidatesStore(null)
    const s = selection()
    await store.store('u1', s)
    await store.attachConversation('u1', s.queryId, 'conv_a')
    await store.attachConversation('u1', s.queryId, 'conv_b')
    expect((await store.retrieve('u1', s.queryId))?.conversationId).toBe('conv_a')
    // Otro usuario no la ve ni la liga.
    await store.attachConversation('u2', s.queryId, 'conv_x')
    expect(await store.retrieve('u2', s.queryId)).toBeNull()
  })

  it('recuerda la reproducción de cada candidato hasta que caduca la búsqueda', async () => {
    const store = new MusicCandidatesStore(null)
    const s = selection()
    await store.rememberPlayback(s, 'aaaaaaaaaaaaaaaa', {
      status: 'playing',
      state: 'COMPLETED',
      message: 'ok',
    })
    expect(await store.recallPlayback(s.queryId, 'aaaaaaaaaaaaaaaa')).toEqual({
      status: 'playing',
      state: 'COMPLETED',
      message: 'ok',
    })
    expect(await store.recallPlayback(s.queryId, 'bbbbbbbbbbbbbbbb')).toBeNull()
    const old = { ...selection(), expiresAt: new Date(Date.now() - 1).toISOString() }
    await store.rememberPlayback(old, 'aaaaaaaaaaaaaaaa', {
      status: 'playing',
      state: null,
      message: 'x',
    })
    expect(await store.recallPlayback(old.queryId, 'aaaaaaaaaaaaaaaa')).toBeNull()
  })
})

/* ───────────────────────── Elección en la tarjeta ───────────────────────── */

describe('elegir un candidato: validación, doble clic y correlación', () => {
  const CANDIDATE = 'aaaaaaaaaaaaaaaa'
  const ctx = { userId: 'u1' } as LumiToolContext

  async function env(play: () => Promise<MusicPlaybackOutcome>) {
    const store = new MusicCandidatesStore(null)
    const s: LumiMusicSelection = {
      ...selection(),
      conversationId: 'conv_a',
      candidates: [
        {
          id: CANDIDATE,
          title: 'Numb',
          artist: '',
          duration: 188,
          thumbnailUrl: null,
          type: 'official',
          ref: 'e4',
          label: 'Numb',
          url: 'https://www.youtube.com/watch?v=kXYiU_JCYtU',
        },
      ],
    }
    await store.store('u1', s)
    let calls = 0
    const deps = {
      store,
      play: async (
        _c: unknown,
        _s: unknown,
        _id: string,
        onProgress?: (p: { state: 'PLAYING' }) => void,
      ) => {
        calls += 1
        onProgress?.({ state: 'PLAYING' })
        return play()
      },
    }
    return { store, s, deps, calls: () => calls }
  }

  const ok = async (): Promise<MusicPlaybackOutcome> => ({
    status: 'playing',
    state: 'COMPLETED',
    text: 'suena',
  })

  it('cada evento lleva los identificadores de la tarjeta que lo pidió', async () => {
    const { s, deps } = await env(ok)
    const events: MusicPlaybackEvent[] = []
    const out = await selectMusicCandidate(
      deps,
      ctx,
      { queryId: s.queryId, candidateId: CANDIDATE, conversationId: 'conv_a', messageId: 'm-1' },
      (e) => events.push(e),
    )
    const ids = {
      queryId: s.queryId,
      candidateId: CANDIDATE,
      conversationId: 'conv_a',
      messageId: 'm-1',
      deviceId: DEVICE,
    }
    expect(events).toEqual([
      { ...ids, state: 'RECEIVED' },
      { ...ids, state: 'PLAYING' },
    ])
    expect(out).toEqual({
      ...ids,
      status: 'playing',
      state: 'COMPLETED',
      message: 'suena',
      replayed: false,
    })
  })

  it('doble clic: el segundo, simultáneo, es «busy» y después se devuelve sin repetir', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { s, deps, calls } = await env(async () => {
      await gate
      return ok()
    })
    const input = { queryId: s.queryId, candidateId: CANDIDATE }
    const first = selectMusicCandidate(deps, ctx, input)
    await vi.waitFor(() => expect(calls()).toBe(1))
    const second = await selectMusicCandidate(deps, ctx, input)
    expect(second.status).toBe('busy')
    release()
    expect((await first).status).toBe('playing')
    const third = await selectMusicCandidate(deps, ctx, input)
    expect(third).toMatchObject({ status: 'playing', state: 'COMPLETED', replayed: true })
    expect(calls()).toBe(1)
  })

  it('tras un fallo se puede volver a intentar', async () => {
    const { s, deps, calls } = await env(async () => ({
      status: 'failed',
      state: 'PLAYBACK_BLOCKED',
      text: 'bloqueado',
    }))
    const input = { queryId: s.queryId, candidateId: CANDIDATE }
    expect((await selectMusicCandidate(deps, ctx, input)).state).toBe('PLAYBACK_BLOCKED')
    await selectMusicCandidate(deps, ctx, input)
    expect(calls()).toBe(2)
  })

  it('rechaza sin ejecutar: otra conversación, otro usuario, búsqueda caducada o candidato ajeno', async () => {
    const { s, deps, calls } = await env(ok)
    const base = { queryId: s.queryId, candidateId: CANDIDATE }
    expect(
      (await selectMusicCandidate(deps, ctx, { ...base, conversationId: 'conv_b' })).status,
    ).toBe('failed')
    expect(
      (await selectMusicCandidate(deps, { userId: 'u2' } as LumiToolContext, base)).status,
    ).toBe('expired')
    expect((await selectMusicCandidate(deps, ctx, { ...base, queryId: randomUUID() })).status).toBe(
      'expired',
    )
    expect(
      (await selectMusicCandidate(deps, ctx, { ...base, candidateId: 'bbbbbbbbbbbbbbbb' })).status,
    ).toBe('failed')
    expect(calls()).toBe(0)
  })
})

/* ───────────────────────── Coincidencia con resultados reales ───────────────────────── */

describe('búsqueda de música: coincidencia con nombres reales de YouTube', () => {
  // Nombres accesibles de una búsqueda real de «linkin park numb» (2026-11-26, interfaz en español).
  const NUMB = [
    'Numb (Official Music Video) [4K UPGRADE] – Linkin Park 3 minutos y 8 segundos',
    'Linkin Park - Numb 3 minutos y 6 segundos',
    'Linkin Park - Numb (Lyrics) 3 minutos y 6 segundos',
    'Numb (Live) - Linkin Park 3 minutos y 13 segundos',
    'Linkin Park - Numb (Live One Take Cover) 3 minutos y 20 segundos',
    'Mix: Numb (Official Music Video) [4K UPGRADE] – Linkin Park',
    'In the End (Official HD Music Video) - Linkin Park 3 minutos y 38 segundos',
  ]
  /** Como el Server: título y canal, sin duración ni visualizaciones. */
  const text = (label: string) => {
    const { title, artist } = parseVideoLabel(label)
    return `${title} ${artist}`
  }

  it('acepta artista y canción en cualquier orden y sin «de»', () => {
    for (const query of ['linkin park numb', 'Numb Linkin Park', 'numb de linkin park']) {
      expect(isFullMatch(matchVideo(query, text(NUMB[0]!))), query).toBe(true)
    }
    // El vídeo oficial no se penaliza por «Official Music Video [4K UPGRADE]».
    expect(matchVideo('linkin park numb', text(NUMB[0]!)).score).toBe(1)
  })

  it('exige todas las palabras: otra canción del mismo artista no es candidata', () => {
    expect(isFullMatch(matchVideo('linkin park numb', text(NUMB[6]!)))).toBe(false)
    expect(isFullMatch(matchVideo('yellow coldplay', NUMB[0]!))).toBe(false)
    expect(isFullMatch(matchVideo('numb de linkin park', 'Dumb - Nirvana'))).toBe(false)
    expect(isFullMatch(matchVideo('linkin park num', NUMB[0]!))).toBe(false)
  })

  it('tolera errores de escritura en palabras largas, no en cortas', () => {
    expect(isFullMatch(matchVideo('linkin prak numb', text(NUMB[1]!)))).toBe(false)
    expect(
      isFullMatch(matchVideo('conspirancy paramore', 'Paramore - Conspiracy (Official Audio)')),
    ).toBe(true)
  })

  it('distingue oficial, letra, en vivo, cover y Mix', () => {
    expect(NUMB.map(videoKind)).toEqual([
      'official',
      'song',
      'lyrics',
      'live',
      'cover',
      'mix',
      'official',
    ])
    expect(KIND_RANK.official).toBeLessThan(KIND_RANK.lyrics)
    expect(KIND_RANK.lyrics).toBeLessThan(KIND_RANK.live)
  })

  it('la versión con letra o en vivo puntúa por debajo del mismo vídeo sin palabras de más', () => {
    const plain = matchVideo('linkin park numb', text(NUMB[1]!)).score
    expect(matchVideo('linkin park numb', text(NUMB[2]!)).score).toBeLessThan(plain)
    expect(matchVideo('linkin park numb', text(NUMB[3]!)).score).toBeLessThan(plain)
  })
})

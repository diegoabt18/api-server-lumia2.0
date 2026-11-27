import type { LumiMusicSelection, LumiToolContext } from '../tools/tool.types.js'
import type { MusicPlaybackOutcome, MusicPlaybackProgress } from '../tools/desktop.tools.js'
import type { MusicCandidatesStore } from './candidates-store.js'
import type { MusicPlaybackState } from './playback-state.js'

export interface MusicSelectionInput {
  queryId: string
  candidateId: string
  /** Conversación de la tarjeta: debe coincidir con la de la búsqueda. */
  conversationId?: string
  /** Id del mensaje de la tarjeta en el cliente: se devuelve en cada evento. */
  messageId?: string
}

/** Identificadores de la operación musical, presentes en cada evento y en el resultado. */
export interface MusicSelectionIds {
  queryId: string
  candidateId: string
  conversationId: string | null
  messageId: string | null
  deviceId: string | null
}

export type MusicSelectionStatus =
  | 'playing'
  | 'partial'
  | 'unverified'
  | 'failed'
  | 'offline'
  | 'expired'
  | 'busy'

export interface MusicSelectionResult extends MusicSelectionIds {
  status: MusicSelectionStatus
  state: MusicPlaybackState | null
  message: string
  /** Ya se había puesto este candidato: se devuelve el resultado anterior sin repetirlo. */
  replayed: boolean
}

export type MusicPlaybackEvent = MusicSelectionIds & MusicPlaybackProgress

export interface MusicSelectionDeps {
  store: MusicCandidatesStore
  play: (
    ctx: LumiToolContext,
    selection: LumiMusicSelection,
    candidateId: string,
    onProgress?: (progress: MusicPlaybackProgress) => void,
  ) => Promise<MusicPlaybackOutcome>
}

/**
 * Pone el candidato elegido en la tarjeta. Antes de ordenar nada comprueba que la búsqueda existe, es
 * de este usuario y sigue vigente («expired»), que el candidato es de esa búsqueda, que la tarjeta es
 * de la misma conversación y que no hay otra reproducción de la búsqueda en curso («busy»). Un
 * candidato que ya se puso se devuelve sin repetirlo (`replayed`). El equipo, su conexión, la pausa y
 * los permisos los comprueba el servicio de ejecuciones al firmar la orden.
 */
export async function selectMusicCandidate(
  deps: MusicSelectionDeps,
  ctx: LumiToolContext,
  input: MusicSelectionInput,
  onEvent?: (event: MusicPlaybackEvent) => void,
): Promise<MusicSelectionResult> {
  const selection = await deps.store.retrieve(ctx.userId, input.queryId)
  const ids: MusicSelectionIds = {
    queryId: input.queryId,
    candidateId: input.candidateId,
    conversationId: selection?.conversationId ?? input.conversationId ?? null,
    messageId: input.messageId ?? null,
    deviceId: selection?.deviceId ?? null,
  }
  const done = (
    r: Pick<MusicSelectionResult, 'status' | 'state' | 'message'> & { replayed?: boolean },
  ): MusicSelectionResult => ({ ...ids, replayed: false, ...r })

  if (!selection) {
    return done({
      status: 'expired',
      state: null,
      message: 'Esta búsqueda ya caducó. Vuelve a pedir la canción.',
    })
  }
  if (
    input.conversationId &&
    selection.conversationId &&
    input.conversationId !== selection.conversationId
  ) {
    return done({
      status: 'failed',
      state: null,
      message: 'Esa tarjeta no es de esta conversación; no hice nada.',
    })
  }
  if (!selection.candidates.some((c) => c.id === input.candidateId)) {
    return done({
      status: 'failed',
      state: null,
      message: 'Ese vídeo no es de esta búsqueda; no hice nada.',
    })
  }
  const previous = await deps.store.recallPlayback(input.queryId, input.candidateId)
  if (previous) return done({ ...previous, replayed: true })
  if (!(await deps.store.lock(input.queryId))) {
    return done({
      status: 'busy',
      state: null,
      message: 'Ya estoy poniendo un vídeo de esta búsqueda; espera a que termine.',
    })
  }
  try {
    onEvent?.({ ...ids, state: 'RECEIVED' })
    const played = await deps.play(ctx, selection, input.candidateId, (progress) =>
      onEvent?.({ ...ids, ...progress }),
    )
    if (played.status === 'playing' || played.status === 'partial') {
      await deps.store.rememberPlayback(selection, input.candidateId, {
        status: played.status,
        state: played.state,
        message: played.text,
      })
    }
    return done({ status: played.status, state: played.state, message: played.text })
  } finally {
    await deps.store.unlock(input.queryId)
  }
}

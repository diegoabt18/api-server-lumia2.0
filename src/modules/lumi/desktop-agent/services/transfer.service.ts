import { createHash } from 'node:crypto'
import { AppError } from '../../../../common/errors/app.error.js'
import type { PermissionId } from '../../../../common/permissions/registry.js'
import {
  MAX_FILE_BYTES,
  TRANSFER_CHUNK_BYTES,
  TRANSFER_MAX_TIMEOUT_MS,
} from '../domain/operations.js'
import {
  transferAckPayloadSchema,
  transferDataPayloadSchema,
  transferOpenPayloadSchema,
  type TransferOpenPayload,
} from '../domain/protocol.js'
import type { DesktopExecutionService, DispatchOutcome } from './execution.service.js'

/**
 * Transferencias de archivos entre un equipo y Lumia Admin (fase 6). El Server **no guarda** los
 * archivos: retransmite bloques de 256 KiB, uno cada vez, y calcula el SHA-256 de lo que pasa.
 *
 *  - Descarga (equipo → navegador): el agente anuncia nombre, tamaño y SHA-256; el Server pide los
 *    bloques en orden y los escribe en la respuesta HTTP. Solo si el hash coincide pide `commit`.
 *  - Subida (navegador → equipo): el hash y el tamaño van en el grant firmado. El Server envía los
 *    bloques en orden y espera el acuse de cada uno; antes del `commit` comprueba que lo recibido
 *    del navegador tiene ese tamaño y ese hash. El agente lo vuelve a comprobar antes de publicar.
 *
 * Cualquier fallo cancela la tarea (`task.cancel`): el agente borra su archivo temporal.
 */

/** Sin noticias del agente durante este tiempo, la transferencia se abandona. */
const IDLE_MS = 60_000

type TransferMessage = { type: `transfer.${string}`; payload: Record<string, unknown> }

/** Cola de mensajes `transfer.*` de una tarea, con espera. */
class Inbox {
  private readonly items: TransferMessage[] = []
  private waiter: ((m: TransferMessage) => void) | null = null

  push(message: TransferMessage) {
    if (this.waiter) {
      const w = this.waiter
      this.waiter = null
      w(message)
    } else if (this.items.length < 16) {
      this.items.push(message)
    }
  }

  next(): Promise<TransferMessage> {
    const item = this.items.shift()
    if (item) return Promise.resolve(item)
    return new Promise((resolve) => (this.waiter = resolve))
  }
}

export interface TransferTarget {
  userId: string
  permissionKeys: readonly PermissionId[]
  deviceId: string
}

/** Destino de una descarga (la respuesta HTTP). */
export interface DownloadSink {
  /** Se llama una vez, con lo que anunció el agente, antes del primer bloque. */
  start(info: TransferOpenPayload): void
  /** Escribe un bloque; debe resolver cuando se puede escribir el siguiente. */
  write(chunk: Buffer): Promise<void>
  end(): void
  /** La transferencia falló después de `start`: cortar la respuesta. */
  abort(): void
}

function transferError(status: number, code: string, message: string) {
  return new AppError(status, message, code)
}

/** Resultado final de la tarea convertido en error HTTP si no terminó bien. */
function failureOf(outcome: DispatchOutcome): AppError {
  const e = outcome.execution.error
  const status = outcome.execution.status
  if (status === 'rejected') {
    return transferError(
      409,
      e?.code ?? 'REJECTED',
      e?.message ?? 'The device refused the transfer',
    )
  }
  if (status === 'cancelled') return transferError(409, 'CANCELLED', 'The transfer was cancelled')
  return transferError(502, e?.code ?? 'TRANSFER_FAILED', e?.message ?? 'The transfer failed')
}

export class DesktopTransferService {
  constructor(private readonly execution: DesktopExecutionService) {}

  /**
   * Ordena la tarea y devuelve su inbox, su id y la promesa del resultado. Errores de
   * autorización o del equipo (antes de enviar nada) se lanzan aquí.
   */
  private async start(
    target: TransferTarget,
    operation: 'files.download' | 'files.upload',
    args: Record<string, unknown>,
  ) {
    const inbox = new Inbox()
    let taskId: string | null = null
    let started!: () => void
    const startedOrFailed = new Promise<void>((resolve) => (started = resolve))
    const done = this.execution.dispatch({
      ...target,
      operation,
      args,
      timeoutMs: TRANSFER_MAX_TIMEOUT_MS,
      onStarted: (id) => {
        taskId = id
        started()
      },
      onTransfer: (type, payload) => inbox.push({ type: type as TransferMessage['type'], payload }),
    })
    // dispatch rechaza antes de onStarted si falla una comprobación previa.
    await Promise.race([startedOrFailed, done])
    if (!taskId) {
      // done terminó sin iniciar: propaga su error (o un fallo genérico).
      await done
      throw transferError(502, 'TRANSFER_FAILED', 'The transfer could not start')
    }
    return { inbox, taskId: taskId as string, done, deviceId: target.deviceId }
  }

  /** Siguiente mensaje de la transferencia, o el resultado final si la tarea terminó antes. */
  private async next(
    inbox: Inbox,
    done: Promise<DispatchOutcome>,
  ): Promise<TransferMessage | { type: 'done'; outcome: DispatchOutcome }> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const idle = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(transferError(504, 'TRANSFER_IDLE', 'The device stopped responding')),
        IDLE_MS,
      )
    })
    try {
      return await Promise.race([
        inbox.next(),
        done.then((outcome) => ({ type: 'done' as const, outcome })),
        idle,
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  private cancel(deviceId: string, taskId: string) {
    this.execution.sendTransfer(deviceId, 'task.cancel', taskId, {})
  }

  /** Equipo → navegador. Lanza antes de `sink.start` si no se pudo empezar. */
  async download(
    target: TransferTarget,
    args: { root: string; path: string },
    sink: DownloadSink,
  ): Promise<DispatchOutcome> {
    const t = await this.start(target, 'files.download', args)
    let started = false
    try {
      const first = await this.next(t.inbox, t.done)
      if (first.type === 'done') throw failureOf(first.outcome)
      const open = transferOpenPayloadSchema.safeParse(first.payload)
      if (first.type !== 'transfer.open' || !open.success) {
        throw transferError(502, 'AGENT_PROTOCOL_ERROR', 'Unexpected transfer message')
      }
      const info = open.data
      sink.start(info)
      started = true

      const hash = createHash('sha256')
      let offset = 0
      while (offset < info.size) {
        const length = Math.min(TRANSFER_CHUNK_BYTES, info.size - offset)
        this.execution.sendTransfer(t.deviceId, 'transfer.read', t.taskId, { offset, length })
        const m = await this.next(t.inbox, t.done)
        if (m.type === 'done') throw failureOf(m.outcome)
        const data = transferDataPayloadSchema.safeParse(m.payload)
        if (m.type !== 'transfer.data' || !data.success || data.data.offset !== offset) {
          throw transferError(502, 'AGENT_PROTOCOL_ERROR', 'Unexpected transfer data')
        }
        const chunk = Buffer.from(data.data.data, 'base64')
        if (chunk.length !== length) {
          throw transferError(502, 'AGENT_PROTOCOL_ERROR', 'Chunk of unexpected size')
        }
        hash.update(chunk)
        await sink.write(chunk)
        offset += chunk.length
      }
      if (hash.digest('hex') !== info.sha256) {
        throw transferError(502, 'INTEGRITY_FAILED', 'The received bytes do not match the SHA-256')
      }
      this.execution.sendTransfer(t.deviceId, 'transfer.commit', t.taskId, {})
      const outcome = await t.done
      if (outcome.execution.status !== 'completed') throw failureOf(outcome)
      sink.end()
      return outcome
    } catch (error) {
      this.cancel(t.deviceId, t.taskId)
      if (started) sink.abort()
      throw error
    }
  }

  /** Navegador → equipo. `source` entrega los bytes del cuerpo HTTP tal como llegan. */
  async upload(
    target: TransferTarget,
    args: { root: string; dir: string; name: string; size: number; sha256: string },
    source: AsyncIterable<Buffer | Uint8Array | string>,
  ): Promise<DispatchOutcome> {
    if (args.size > MAX_FILE_BYTES) {
      throw transferError(413, 'FILE_TOO_LARGE', 'The file exceeds the size limit')
    }
    const t = await this.start(target, 'files.upload', args)
    try {
      const first = await this.next(t.inbox, t.done)
      if (first.type === 'done') throw failureOf(first.outcome)
      if (
        first.type !== 'transfer.open' ||
        !transferOpenPayloadSchema.safeParse(first.payload).success
      ) {
        throw transferError(502, 'AGENT_PROTOCOL_ERROR', 'Unexpected transfer message')
      }

      const hash = createHash('sha256')
      let offset = 0
      let pending = Buffer.alloc(0)
      const send = async (chunk: Buffer) => {
        this.execution.sendTransfer(t.deviceId, 'transfer.write', t.taskId, {
          offset,
          data: chunk.toString('base64'),
        })
        const m = await this.next(t.inbox, t.done)
        if (m.type === 'done') throw failureOf(m.outcome)
        const ack = transferAckPayloadSchema.safeParse(m.payload)
        if (
          m.type !== 'transfer.ack' ||
          !ack.success ||
          ack.data.offset !== offset ||
          ack.data.length !== chunk.length
        ) {
          throw transferError(502, 'AGENT_PROTOCOL_ERROR', 'Unexpected transfer acknowledgement')
        }
        offset += chunk.length
      }
      for await (const part of source) {
        const buf = typeof part === 'string' ? Buffer.from(part) : Buffer.from(part)
        if (offset + pending.length + buf.length > args.size) {
          throw transferError(400, 'SIZE_MISMATCH', 'The body is larger than the declared size')
        }
        hash.update(buf)
        pending = pending.length ? Buffer.concat([pending, buf]) : buf
        while (pending.length >= TRANSFER_CHUNK_BYTES) {
          await send(pending.subarray(0, TRANSFER_CHUNK_BYTES))
          pending = pending.subarray(TRANSFER_CHUNK_BYTES)
        }
      }
      if (pending.length) await send(pending)
      if (offset !== args.size) {
        throw transferError(400, 'SIZE_MISMATCH', 'The body is smaller than the declared size')
      }
      if (hash.digest('hex') !== args.sha256) {
        throw transferError(400, 'INTEGRITY_FAILED', 'The body does not match the declared SHA-256')
      }
      this.execution.sendTransfer(t.deviceId, 'transfer.commit', t.taskId, {})
      const outcome = await t.done
      if (outcome.execution.status !== 'completed') throw failureOf(outcome)
      return outcome
    } catch (error) {
      this.cancel(t.deviceId, t.taskId)
      throw error
    }
  }
}

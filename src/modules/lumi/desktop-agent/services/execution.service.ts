import { randomBytes, randomUUID } from 'node:crypto'
import { AppError } from '../../../../common/errors/app.error.js'
import { hasPermission, type PermissionId } from '../../../../common/permissions/registry.js'
import {
  DEFAULT_TIMEOUT_MS,
  DESKTOP_OPERATIONS,
  GRANT_LIFETIME_SECONDS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  TRANSFER_MAX_TIMEOUT_MS,
  TRANSFER_OPERATIONS,
  isDesktopOperation,
} from '../domain/operations.js'
import {
  taskResultPayloadSchema,
  taskStatePayloadSchema,
  type Envelope,
  type TaskError,
  type TaskStage,
} from '../domain/protocol.js'
import type { DesktopDeviceStore } from '../infrastructure/desktop-device.repository.js'
import {
  FINAL_STATUSES,
  type DesktopExecution,
  type DesktopExecutionStore,
  type ExecutionStatus,
} from '../infrastructure/desktop-execution.repository.js'
import { GRANT_ISSUER, type GrantSigner } from '../infrastructure/grant-signer.js'

/** Lo que el servicio necesita de la pasarela WebSocket. */
export interface TaskTransport {
  isOnline(deviceId: string): boolean
  sendTask(
    deviceId: string,
    type: string,
    taskId: string,
    payload: Record<string, unknown>,
  ): boolean
}

type Log = {
  info: (obj: object, msg: string) => void
  warn: (obj: object, msg: string) => void
}

export interface ExecutionServiceDeps {
  devices: DesktopDeviceStore
  executions: DesktopExecutionStore
  signer: GrantSigner
  transport: TaskTransport
  now?: () => Date
  log?: Log
}

export interface DispatchInput {
  userId: string
  permissionKeys: readonly PermissionId[]
  deviceId: string
  operation: string
  args: unknown
  timeoutMs?: number
  /** La tarea se envió al agente (antes de su resultado). */
  onStarted?: (executionId: string) => void
  /** Mensajes `transfer.*` del agente para esta tarea (solo operaciones con transferencia). */
  onTransfer?: (type: string, payload: Record<string, unknown>) => void
  /** Pasos verificados que el agente informa de esta tarea (solo los de este despacho). */
  onStage?: (stage: TaskStage) => void
}

export interface DispatchOutcome {
  execution: DesktopExecutionView
  /** Resultado de la operación tal como lo devolvió el agente. Solo en la respuesta, nunca en base de datos. */
  result: unknown
}

/** Margen tras el tiempo límite antes de dar la ejecución por perdida. */
const WATCHDOG_GRACE_MS = 15_000

export function toExecutionView(e: DesktopExecution) {
  return {
    id: e.id,
    deviceId: e.deviceId,
    operation: e.operation,
    argsSummary: e.argsSummary,
    status: e.status,
    verification: e.verification,
    error: e.error,
    cancelRequested: e.cancelRequested,
    createdAt: e.createdAt.toISOString(),
    finishedAt: e.finishedAt?.toISOString() ?? null,
    durationMs: e.durationMs,
  }
}
export type DesktopExecutionView = ReturnType<typeof toExecutionView>

function problem(status: number, code: string, message: string) {
  return new AppError(status, message, code)
}

/**
 * Ejecución de operaciones en equipos de escritorio. Aquí se decide la autorización:
 *  1. operación del catálogo y argumentos válidos (esquema estricto);
 *  2. permiso de quien la pide;
 *  3. el equipo es suyo, está activo, conectado, no pausado y anuncia la operación;
 *  4. se firma un grant de un solo uso para ese equipo, tarea y argumentos.
 * El agente solo comprueba la firma; nunca amplía lo autorizado.
 */
export class DesktopExecutionService {
  private readonly now: () => Date
  private readonly waiters = new Map<string, (result: unknown) => void>()
  /** Mensaje de despacho guardado hasta que el agente lo recibe (para reenviarlo tras una reconexión). */
  private readonly undelivered = new Map<
    string,
    { deviceId: string; payload: Record<string, unknown> }
  >()
  private readonly watchdogs = new Map<string, ReturnType<typeof setTimeout>>()
  /** Transferencias en curso: tarea → equipo y receptor de sus mensajes `transfer.*`. */
  /** Transferencias cortadas por una desconexión, pendientes de cancelar en el agente. */
  private readonly abandoned = new Set<string>()
  private readonly transfers = new Map<
    string,
    { deviceId: string; listener: (type: string, payload: Record<string, unknown>) => void }
  >()
  /** Receptor de los pasos de cada tarea en curso: solo el despacho que la originó los recibe. */
  private readonly stageListeners = new Map<string, (stage: TaskStage) => void>()

  constructor(private readonly deps: ExecutionServiceDeps) {
    this.now = deps.now ?? (() => new Date())
  }

  async dispatch(input: DispatchInput): Promise<DispatchOutcome> {
    if (!isDesktopOperation(input.operation)) {
      throw problem(400, 'UNKNOWN_OPERATION', 'Unknown desktop operation')
    }
    const operation = DESKTOP_OPERATIONS[input.operation]!
    if (!hasPermission([...input.permissionKeys], operation.permission)) {
      throw AppError.forbidden('Insufficient permissions')
    }
    const parsedArgs = operation.args.safeParse(input.args ?? {})
    if (!parsedArgs.success)
      throw AppError.badRequest('Invalid arguments', parsedArgs.error.flatten())
    const args = parsedArgs.data as Record<string, unknown>
    const transfer = TRANSFER_OPERATIONS.includes(input.operation)
    const timeoutMs = Math.min(
      transfer ? TRANSFER_MAX_TIMEOUT_MS : MAX_TIMEOUT_MS,
      Math.max(MIN_TIMEOUT_MS, input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    )

    const device = await this.deps.devices.findById(input.deviceId)
    // Equipo ajeno o inexistente: 404 en ambos casos (no se revela qué equipos existen).
    if (!device || device.ownerUserId !== input.userId) throw AppError.notFound('Device not found')
    if (device.status !== 'active') throw problem(409, 'DEVICE_REVOKED', 'The device is revoked')
    if (!this.deps.transport.isOnline(device.id))
      throw problem(409, 'DEVICE_OFFLINE', 'The device is not connected')
    if (device.execution === 'paused') {
      throw problem(409, 'DEVICE_PAUSED', 'Execution is paused on the device')
    }
    if (!device.capabilities?.operations.includes(input.operation)) {
      throw problem(
        409,
        'OPERATION_NOT_SUPPORTED',
        'The device does not support this operation right now',
      )
    }

    const now = this.now()
    const iat = Math.floor(now.getTime() / 1000)
    const execution: DesktopExecution = {
      id: `exe_${randomBytes(12).toString('hex')}`,
      deviceId: device.id,
      userId: input.userId,
      authorizationId: `auth_${randomUUID()}`,
      operation: input.operation,
      argsSummary: operation.summarize(args),
      status: 'dispatched',
      timeoutMs,
      grantExpiresAt: new Date((iat + GRANT_LIFETIME_SECONDS) * 1000),
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
      durationMs: null,
      verification: null,
      error: null,
      cancelRequested: false,
    }
    const grant = this.deps.signer.sign({
      iss: GRANT_ISSUER,
      aud: device.id,
      jti: execution.authorizationId,
      task_id: execution.id,
      sub: input.userId,
      op: input.operation,
      args,
      iat,
      exp: iat + GRANT_LIFETIME_SECONDS,
    })
    await this.deps.executions.insert(execution)
    this.deps.log?.info(
      {
        executionId: execution.id,
        deviceId: device.id,
        userId: input.userId,
        operation: input.operation,
      },
      'Desktop execution dispatched',
    )

    const payload = { grant, timeout_ms: timeoutMs }
    const finished = new Promise<unknown>((resolve) => this.waiters.set(execution.id, resolve))
    this.undelivered.set(execution.id, { deviceId: device.id, payload })
    this.watchdogs.set(
      execution.id,
      setTimeout(() => {
        void this.finalize(execution.id, {
          status: 'timed_out',
          error: {
            code: 'NO_RESULT',
            message: 'The device did not report a result in time',
            retryable: true,
          },
        })
      }, timeoutMs + WATCHDOG_GRACE_MS),
    )
    if (input.onStage) this.stageListeners.set(execution.id, input.onStage)
    if (transfer && input.onTransfer) {
      this.transfers.set(execution.id, { deviceId: device.id, listener: input.onTransfer })
    }
    this.deps.transport.sendTask(device.id, 'task.dispatch', execution.id, payload)
    input.onStarted?.(execution.id)

    const result = await finished
    const final = (await this.deps.executions.findById(execution.id)) ?? execution
    return { execution: toExecutionView(final), result }
  }

  /** Mensaje de una transferencia en curso hacia el agente (o `task.cancel`). */
  sendTransfer(deviceId: string, type: string, taskId: string, payload: Record<string, unknown>) {
    this.deps.transport.sendTask(deviceId, type, taskId, payload)
  }

  /** Mensajes `task.state`, `task.result` y `transfer.*` de un agente autenticado como `deviceId`. */
  async onAgentMessage(deviceId: string, envelope: Envelope): Promise<void> {
    const taskId = envelope.task_id
    if (!taskId) return
    if (envelope.message_type.startsWith('transfer.')) {
      // Sin lectura de base de datos por bloque: la transferencia debe estar en curso y ser de
      // ese mismo equipo. Lo demás se ignora.
      const transfer = this.transfers.get(taskId)
      if (transfer && transfer.deviceId === deviceId) {
        transfer.listener(envelope.message_type, envelope.payload)
      } else {
        this.deps.log?.warn({ deviceId, taskId }, 'Desktop agent sent data for no transfer')
      }
      return
    }
    const execution = await this.deps.executions.findById(taskId)
    if (!execution || execution.deviceId !== deviceId) {
      // Un equipo no puede informar de tareas de otro. Se confirma para que deje de reenviarlo.
      this.deps.log?.warn({ deviceId, taskId }, 'Desktop agent reported an unknown task')
      if (envelope.message_type === 'task.result') this.ack(deviceId, taskId)
      return
    }

    if (envelope.message_type === 'task.state') {
      const parsed = taskStatePayloadSchema.safeParse(envelope.payload)
      if (!parsed.success) return
      this.undelivered.delete(taskId)
      const open = await this.deps.executions.updateIfOpen(taskId, {
        status: parsed.data.state,
        updatedAt: this.now(),
      })
      // Un paso de una tarea ya cerrada (o de otro despacho) no llega a nadie.
      const stage = parsed.data.stage
      if (stage && open) {
        try {
          this.stageListeners.get(taskId)?.(stage)
        } catch (error) {
          this.deps.log?.warn({ taskId, stage, error: String(error) }, 'Stage listener failed')
        }
      }
      return
    }

    if (envelope.message_type === 'task.result') {
      this.ack(deviceId, taskId)
      const parsed = taskResultPayloadSchema.safeParse(envelope.payload)
      if (!parsed.success) {
        await this.finalize(taskId, {
          status: 'failed',
          error: {
            code: 'AGENT_PROTOCOL_ERROR',
            message: 'Malformed task.result',
            retryable: false,
          },
        })
        return
      }
      const r = parsed.data
      await this.finalize(
        taskId,
        {
          status: r.status,
          verification: r.verification,
          error: r.error,
          durationMs: r.duration_ms,
        },
        r.result ?? null,
      )
    }
  }

  /**
   * El equipo perdió la conexión: sus transferencias en curso no pueden continuar (los bloques en
   * vuelo se perdieron). Fallan ya, sin esperar al tiempo de inactividad, y al reconectar se
   * cancelan en el agente para que borre su archivo temporal.
   */
  async onDeviceDisconnected(deviceId: string): Promise<void> {
    for (const [taskId, transfer] of [...this.transfers]) {
      if (transfer.deviceId !== deviceId) continue
      this.abandoned.add(`${deviceId}|${taskId}`)
      await this.finalize(taskId, {
        status: 'failed',
        error: {
          code: 'DEVICE_DISCONNECTED',
          message: 'The device disconnected during the transfer',
          retryable: true,
        },
      })
    }
  }

  /** Tras una reconexión: reenvía despachos que el agente no llegó a recibir y caduca los vencidos. */
  async onDeviceReady(deviceId: string): Promise<void> {
    for (const key of [...this.abandoned]) {
      const [owner, taskId] = key.split('|')
      if (owner !== deviceId || !taskId) continue
      this.abandoned.delete(key)
      this.deps.transport.sendTask(deviceId, 'task.cancel', taskId, {})
    }
    const open = await this.deps.executions.listOpenByDevice(deviceId)
    for (const execution of open) {
      const pending = this.undelivered.get(execution.id)
      if (execution.status !== 'dispatched') continue
      if (pending && execution.grantExpiresAt > this.now()) {
        this.deps.transport.sendTask(deviceId, 'task.dispatch', execution.id, pending.payload)
      } else {
        await this.finalize(execution.id, {
          status: 'failed',
          error: {
            code: 'DELIVERY_EXPIRED',
            message: 'The order could not be delivered in time',
            retryable: true,
          },
        })
      }
    }
  }

  async cancel(executionId: string, userId: string, permissionKeys: readonly PermissionId[]) {
    const execution = await this.deps.executions.findById(executionId)
    if (!execution || execution.userId !== userId) throw AppError.notFound('Execution not found')
    const operation = DESKTOP_OPERATIONS[execution.operation]
    if (!operation || !hasPermission([...permissionKeys], operation.permission)) {
      throw AppError.forbidden('Insufficient permissions')
    }
    if (FINAL_STATUSES.includes(execution.status)) return toExecutionView(execution)
    const updated = await this.deps.executions.updateIfOpen(executionId, {
      cancelRequested: true,
      updatedAt: this.now(),
    })
    this.deps.transport.sendTask(execution.deviceId, 'task.cancel', executionId, {})
    return toExecutionView(updated ?? execution)
  }

  async listForDevice(
    deviceId: string,
    userId: string,
    limit = 50,
  ): Promise<DesktopExecutionView[]> {
    const device = await this.deps.devices.findById(deviceId)
    if (!device || device.ownerUserId !== userId) throw AppError.notFound('Device not found')
    return (await this.deps.executions.listByDevice(deviceId, Math.min(100, limit))).map(
      toExecutionView,
    )
  }

  /** Para el cierre ordenado del Server. */
  shutdown(): void {
    for (const timer of this.watchdogs.values()) clearTimeout(timer)
    this.watchdogs.clear()
    for (const resolve of this.waiters.values()) resolve(null)
    this.waiters.clear()
    this.stageListeners.clear()
  }

  private ack(deviceId: string, taskId: string) {
    this.deps.transport.sendTask(deviceId, 'task.result.ack', taskId, {})
  }

  private async finalize(
    taskId: string,
    outcome: {
      status: ExecutionStatus
      verification?: { verified: boolean; method: string } | null
      error?: TaskError | null
      durationMs?: number
    },
    result: unknown = null,
  ): Promise<void> {
    this.transfers.delete(taskId)
    this.stageListeners.delete(taskId)
    const now = this.now()
    const current = await this.deps.executions.findById(taskId)
    const updated = await this.deps.executions.updateIfOpen(taskId, {
      status: outcome.status,
      verification: outcome.verification ?? null,
      error: outcome.error ?? null,
      durationMs:
        outcome.durationMs ?? (current ? now.getTime() - current.createdAt.getTime() : null),
      finishedAt: now,
      updatedAt: now,
    })
    const timer = this.watchdogs.get(taskId)
    if (timer) clearTimeout(timer)
    this.watchdogs.delete(taskId)
    this.undelivered.delete(taskId)
    const resolve = this.waiters.get(taskId)
    this.waiters.delete(taskId)
    if (updated) {
      this.deps.log?.info(
        { executionId: taskId, status: updated.status, errorCode: updated.error?.code ?? null },
        'Desktop execution finished',
      )
    }
    // Un resultado que llega después de terminar (p. ej. tras el vigilante) no cambia nada.
    resolve?.(updated ? result : null)
  }
}

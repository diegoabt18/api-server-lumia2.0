import { randomUUID } from 'node:crypto'
import { newNonce, verifyEd25519, type DesktopDevice } from '../domain/device.js'
import {
  AGENT_TRANSFER_MESSAGES,
  AUTH_TIMEOUT_MS,
  CLOSE_CODES,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  PROTOCOL_VERSION,
  authSigningString,
  authenticatePayloadSchema,
  capabilityReportPayloadSchema,
  deviceStatusPayloadSchema,
  envelopeSchema,
  helloPayloadSchema,
  negotiateVersion,
  type Envelope,
  type SessionErrorCode,
} from '../domain/protocol.js'
import type { DesktopDeviceStore } from '../infrastructure/desktop-device.repository.js'
import type { GrantKey } from '../infrastructure/grant-signer.js'

/** Lo mínimo que la pasarela necesita de un WebSocket (permite probarla sin red). */
export interface AgentSocket {
  send(data: string): void
  close(code: number, reason: string): void
}

export interface AgentConnectionHandle {
  onMessage(raw: string): Promise<void>
  onClose(): void
}

type Log = {
  info: (obj: object, msg: string) => void
  warn: (obj: object, msg: string) => void
}

/** Recibe los mensajes de tarea de los agentes (el servicio de ejecuciones). */
export interface TaskMessageHandler {
  onAgentMessage(deviceId: string, envelope: Envelope): Promise<void>
  onDeviceReady(deviceId: string): Promise<void>
  /** El equipo se quedó sin conexión (no la sustituyó otra). */
  onDeviceDisconnected?(deviceId: string): Promise<void>
}

export interface DesktopGatewayDeps {
  devices: DesktopDeviceStore
  /** Claves públicas de grants que se entregan en `session.ready` (1.1). */
  grantKeys?: () => GrantKey[]
  now?: () => Date
  log?: Log
}

/** Máximo de mensajes por ventana antes de cerrar la conexión. */
const RATE_WINDOW_MS = 10_000
const RATE_MAX_MESSAGES = 60
/**
 * Mensajes de transferencia: no cuentan en el límite general porque cada uno responde a una
 * petición del Server (`task.dispatch`, `transfer.read`, `transfer.write`). Cada petición da un
 * cupo; un mensaje de transferencia sin cupo cierra la conexión como cualquier exceso.
 */
const TRANSFER_REQUESTS = new Set(['task.dispatch', 'transfer.read', 'transfer.write'])
const MAX_TRANSFER_CREDITS = 64
/** `lastSeenAt` se escribe como mucho una vez por minuto por equipo. */
const TOUCH_THROTTLE_MS = 60_000

type Phase = 'hello' | 'auth' | 'ready' | 'closed'

/**
 * Pasarela WebSocket de los agentes de escritorio. Cada conexión pasa por:
 *   hello → challenge → authenticate (firma Ed25519 de la clave del equipo) → ready.
 * Un equipo solo tiene una conexión viva: la nueva sustituye a la anterior.
 *
 * Los mensajes `task.state` y `task.result` se entregan al servicio de ejecuciones; sin él se
 * rechazan con OPERATION_NOT_AVAILABLE. Un agente nunca puede enviar `task.dispatch`.
 */
export class DesktopGateway {
  private readonly online = new Map<string, DeviceConnection>()
  private taskHandler: TaskMessageHandler | null = null
  readonly now: () => Date

  constructor(readonly deps: DesktopGatewayDeps) {
    this.now = deps.now ?? (() => new Date())
  }

  accept(socket: AgentSocket, meta: { ip: string | null } = { ip: null }): AgentConnectionHandle {
    const connection = new DeviceConnection(this, socket, meta.ip)
    // Los mensajes de una conexión se procesan en orden aunque su manejo sea asíncrono.
    let queue: Promise<void> = Promise.resolve()
    return {
      onMessage: (raw) => {
        queue = queue.then(() => connection.handle(raw)).catch(() => undefined)
        return queue
      },
      onClose: () => connection.closed(),
    }
  }

  /** El servicio de ejecuciones se conecta después de crearse (se necesitan mutuamente). */
  setTaskHandler(handler: TaskMessageHandler): void {
    this.taskHandler = handler
  }

  /** @internal */
  get tasks(): TaskMessageHandler | null {
    return this.taskHandler
  }

  /** Envía un mensaje de tarea al agente conectado. false si el equipo no está en línea. */
  sendTask(
    deviceId: string,
    type: string,
    taskId: string,
    payload: Record<string, unknown>,
  ): boolean {
    const connection = this.online.get(deviceId)
    if (!connection) return false
    connection.sendMessage(type, payload, null, taskId)
    return true
  }

  isOnline(deviceId: string): boolean {
    return this.online.has(deviceId)
  }

  get onlineCount(): number {
    return this.online.size
  }

  /** Avisa al agente de que fue revocado y corta la conexión. */
  disconnectRevoked(deviceId: string): void {
    const connection = this.online.get(deviceId)
    if (!connection) return
    connection.sendMessage('device.revoked', { reason: 'revoked_by_owner' })
    connection.terminate(CLOSE_CODES.revoked, 'device revoked')
  }

  shutdown(): void {
    for (const connection of [...this.online.values()])
      connection.terminate(CLOSE_CODES.shuttingDown, 'server shutting down')
  }

  /** @internal */
  register(deviceId: string, connection: DeviceConnection): void {
    const previous = this.online.get(deviceId)
    this.online.set(deviceId, connection)
    if (previous && previous !== connection)
      previous.terminate(CLOSE_CODES.replaced, 'replaced by a new connection')
  }

  /** @internal */
  unregister(deviceId: string, connection: DeviceConnection): void {
    if (this.online.get(deviceId) === connection) this.online.delete(deviceId)
  }
}

class DeviceConnection {
  private phase: Phase = 'hello'
  private readonly connectionId = randomUUID()
  private nonce: string | null = null
  private device: DesktopDevice | null = null
  private claimedDeviceId: string | null = null
  private authTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null
  private windowStart = 0
  private windowCount = 0
  private transferCredits = 0
  private lastTouch = 0

  constructor(
    private readonly gateway: DesktopGateway,
    private readonly socket: AgentSocket,
    private readonly ip: string | null,
  ) {
    this.authTimer = setTimeout(() => {
      this.sendError('AUTHENTICATION_TIMEOUT', 'Authentication not completed in time', false)
      this.terminate(CLOSE_CODES.unauthenticated, 'authentication timeout')
    }, AUTH_TIMEOUT_MS)
  }

  async handle(raw: string): Promise<void> {
    if (this.phase === 'closed') return
    // Comprobación barata antes de analizar el JSON; los de transferencia se comprueban después.
    const transferLike = raw.includes('"transfer.')
    if (!transferLike && !this.withinRate()) return this.rateLimited()
    this.resetHeartbeat()

    let envelope: Envelope
    try {
      const parsed = envelopeSchema.safeParse(JSON.parse(raw))
      if (!parsed.success) throw new Error('invalid envelope')
      envelope = parsed.data
    } catch {
      this.sendError('MALFORMED_MESSAGE', 'Message does not match the protocol envelope', false)
      this.terminate(CLOSE_CODES.malformed, 'malformed message')
      return
    }

    if (transferLike) {
      const solicited = (AGENT_TRANSFER_MESSAGES as readonly string[]).includes(
        envelope.message_type,
      )
      if (solicited && this.phase === 'ready') {
        if (this.transferCredits <= 0) return this.rateLimited()
        this.transferCredits -= 1
      } else if (!this.withinRate()) {
        return this.rateLimited()
      }
    }

    if (this.phase === 'hello') return this.onHello(envelope)
    if (this.phase === 'auth') return this.onAuthenticate(envelope)
    return this.onReady(envelope)
  }

  private rateLimited(): void {
    this.sendError('RATE_LIMITED', 'Too many messages', false)
    this.terminate(CLOSE_CODES.rateLimited, 'rate limited')
  }

  closed(): void {
    if (this.phase === 'closed') return
    const wasReady = this.phase === 'ready'
    this.phase = 'closed'
    this.clearTimers()
    if (wasReady && this.device) {
      this.gateway.unregister(this.device.id, this)
      void this.gateway.deps.devices
        .touch(this.device.id, { lastSeenAt: this.gateway.now() })
        .catch(() => undefined)
      this.gateway.deps.log?.info({ deviceId: this.device.id }, 'Desktop agent disconnected')
      if (!this.gateway.isOnline(this.device.id)) {
        void this.gateway.tasks?.onDeviceDisconnected?.(this.device.id).catch(() => undefined)
      }
    }
  }

  terminate(code: number, reason: string): void {
    if (this.phase === 'closed') return
    try {
      this.socket.close(code, reason)
    } finally {
      this.closed()
    }
  }

  sendMessage(
    type: string,
    payload: Record<string, unknown>,
    correlationId: string | null = null,
    taskId: string | null = null,
  ): void {
    if (TRANSFER_REQUESTS.has(type)) {
      this.transferCredits = Math.min(MAX_TRANSFER_CREDITS, this.transferCredits + 1)
    }
    const message = {
      protocol_version: PROTOCOL_VERSION,
      message_id: randomUUID(),
      message_type: type,
      timestamp: this.gateway.now().toISOString(),
      device_id: this.device?.id ?? this.claimedDeviceId,
      task_id: taskId,
      correlation_id: correlationId,
      payload,
    }
    try {
      this.socket.send(JSON.stringify(message))
    } catch {
      // Socket cerrado entre medias: el evento de cierre limpia el estado.
    }
  }

  private sendError(
    code: SessionErrorCode,
    message: string,
    retryable: boolean,
    correlationId: string | null = null,
  ) {
    this.sendMessage('session.error', { code, message, retryable }, correlationId)
  }

  private async onHello(envelope: Envelope): Promise<void> {
    if (envelope.message_type !== 'session.hello' || !envelope.device_id) {
      this.sendError(
        'UNEXPECTED_MESSAGE',
        'Expected session.hello with device_id',
        false,
        envelope.message_id,
      )
      this.terminate(CLOSE_CODES.unauthenticated, 'expected hello')
      return
    }
    const hello = helloPayloadSchema.safeParse(envelope.payload)
    if (!hello.success) {
      this.sendError(
        'MALFORMED_MESSAGE',
        'Invalid session.hello payload',
        false,
        envelope.message_id,
      )
      this.terminate(CLOSE_CODES.malformed, 'invalid hello')
      return
    }
    if (!negotiateVersion(hello.data.protocol_versions)) {
      this.sendError(
        'PROTOCOL_UNSUPPORTED',
        `Server speaks ${PROTOCOL_VERSION}`,
        false,
        envelope.message_id,
      )
      this.terminate(CLOSE_CODES.protocolUnsupported, 'protocol unsupported')
      return
    }
    this.claimedDeviceId = envelope.device_id
    // Siempre se envía desafío, exista o no el equipo: la respuesta no revela qué ids existen.
    this.device = await this.gateway.deps.devices.findById(envelope.device_id).catch(() => null)
    if (this.phase === 'closed') return
    this.nonce = newNonce()
    this.phase = 'auth'
    this.sendMessage(
      'session.challenge',
      {
        nonce: this.nonce,
        connection_id: this.connectionId,
        server_time: this.gateway.now().toISOString(),
      },
      envelope.message_id,
    )
    if (this.device) this.device.agentVersion = hello.data.agent_version
  }

  private async onAuthenticate(envelope: Envelope): Promise<void> {
    const body = authenticatePayloadSchema.safeParse(envelope.payload)
    const device = this.device
    const valid =
      envelope.message_type === 'session.authenticate' &&
      envelope.device_id === this.claimedDeviceId &&
      body.success &&
      device !== null &&
      this.nonce !== null &&
      verifyEd25519(
        device.publicKey,
        authSigningString(this.nonce, device.id, this.connectionId),
        body.data.signature,
      )
    this.nonce = null

    if (!valid || !device) {
      this.gateway.deps.log?.warn(
        { deviceId: this.claimedDeviceId, ip: this.ip },
        'Desktop agent authentication failed',
      )
      this.sendError('AUTHENTICATION_FAILED', 'Authentication failed', false, envelope.message_id)
      this.terminate(CLOSE_CODES.unauthenticated, 'authentication failed')
      return
    }
    if (device.status !== 'active') {
      // La firma es válida: el agente es quien dice ser y debe saber que fue revocado.
      this.sendMessage('device.revoked', { reason: 'revoked_by_owner' }, envelope.message_id)
      this.terminate(CLOSE_CODES.revoked, 'device revoked')
      return
    }

    if (this.authTimer) clearTimeout(this.authTimer)
    this.authTimer = null
    this.phase = 'ready'
    this.gateway.register(device.id, this)
    this.lastTouch = this.gateway.now().getTime()
    await this.gateway.deps.devices
      .touch(device.id, { lastSeenAt: this.gateway.now(), agentVersion: device.agentVersion })
      .catch(() => undefined)
    this.gateway.deps.log?.info({ deviceId: device.id, ip: this.ip }, 'Desktop agent connected')
    this.sendMessage(
      'session.ready',
      {
        session_id: this.connectionId,
        negotiated_version: PROTOCOL_VERSION,
        heartbeat_interval_ms: HEARTBEAT_INTERVAL_MS,
        server_time: this.gateway.now().toISOString(),
        grant_keys: this.gateway.deps.grantKeys?.() ?? [],
      },
      envelope.message_id,
    )
    // Despachos que no llegaron a entregarse antes de la desconexión.
    void this.gateway.tasks?.onDeviceReady(device.id).catch(() => undefined)
  }

  private async onReady(envelope: Envelope): Promise<void> {
    const device = this.device as DesktopDevice
    if (envelope.device_id !== device.id) {
      this.sendError(
        'MALFORMED_MESSAGE',
        'device_id does not match the session',
        false,
        envelope.message_id,
      )
      this.terminate(CLOSE_CODES.malformed, 'device mismatch')
      return
    }
    switch (envelope.message_type) {
      case 'session.ping':
        this.sendMessage('session.pong', {}, envelope.message_id)
        await this.touchSeen()
        return
      case 'session.pong':
        return
      case 'device.status': {
        const parsed = deviceStatusPayloadSchema.safeParse(envelope.payload)
        if (!parsed.success)
          return this.sendError(
            'MALFORMED_MESSAGE',
            'Invalid device.status',
            false,
            envelope.message_id,
          )
        await this.gateway.deps.devices
          .touch(device.id, { execution: parsed.data.execution, lastSeenAt: this.gateway.now() })
          .catch(() => undefined)
        return
      }
      case 'capability.report': {
        const parsed = capabilityReportPayloadSchema.safeParse(envelope.payload)
        if (!parsed.success)
          return this.sendError(
            'MALFORMED_MESSAGE',
            'Invalid capability.report',
            false,
            envelope.message_id,
          )
        await this.gateway.deps.devices
          .touch(device.id, { capabilities: parsed.data, lastSeenAt: this.gateway.now() })
          .catch(() => undefined)
        return
      }
      case 'task.state':
      case 'task.result':
      case 'transfer.open':
      case 'transfer.data':
      case 'transfer.ack': {
        const handler = this.gateway.tasks
        if (!handler) {
          return this.sendError(
            'OPERATION_NOT_AVAILABLE',
            'Task execution is not enabled',
            false,
            envelope.message_id,
          )
        }
        await handler.onAgentMessage(device.id, envelope).catch((err: unknown) => {
          this.gateway.deps.log?.warn({ err, deviceId: device.id }, 'Desktop task message failed')
        })
        return
      }
      default:
        return this.sendError(
          'UNEXPECTED_MESSAGE',
          `Unknown message type ${envelope.message_type}`,
          false,
          envelope.message_id,
        )
    }
  }

  private async touchSeen(): Promise<void> {
    const now = this.gateway.now().getTime()
    if (!this.device || now - this.lastTouch < TOUCH_THROTTLE_MS) return
    this.lastTouch = now
    await this.gateway.deps.devices
      .touch(this.device.id, { lastSeenAt: new Date(now) })
      .catch(() => undefined)
  }

  private withinRate(): boolean {
    const now = Date.now()
    if (now - this.windowStart > RATE_WINDOW_MS) {
      this.windowStart = now
      this.windowCount = 0
    }
    this.windowCount += 1
    return this.windowCount <= RATE_MAX_MESSAGES
  }

  private resetHeartbeat(): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer)
    this.heartbeatTimer = setTimeout(
      () => this.terminate(CLOSE_CODES.heartbeatTimeout, 'heartbeat timeout'),
      HEARTBEAT_TIMEOUT_MS,
    )
  }

  private clearTimers(): void {
    if (this.authTimer) clearTimeout(this.authTimer)
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer)
    this.authTimer = null
    this.heartbeatTimer = null
  }
}

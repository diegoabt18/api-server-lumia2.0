import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import Fastify from 'fastify'
import { WebSocket } from 'ws'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '../../src/common/errors/app.error.js'
import {
  generateEnrollmentCode,
  hashEnrollmentCode,
  normalizeEnrollmentCode,
  verifyEd25519,
} from '../../src/modules/lumi/desktop-agent/domain/device.js'
import {
  CLOSE_CODES,
  capabilityReportPayloadSchema,
  envelopeSchema,
  helloPayloadSchema,
  taskResultPayloadSchema,
  transferAckPayloadSchema,
  transferDataPayloadSchema,
  transferOpenPayloadSchema,
  taskStatePayloadSchema,
  HEARTBEAT_TIMEOUT_MS,
  authSigningString,
  registrationSigningString,
} from '../../src/modules/lumi/desktop-agent/domain/protocol.js'
import {
  MemoryDesktopDeviceStore,
  MemoryDesktopEnrollmentStore,
  MemoryPendingRegistrationStore,
} from '../../src/modules/lumi/desktop-agent/infrastructure/desktop-device.repository.js'
import {
  DesktopGateway,
  type AgentSocket,
} from '../../src/modules/lumi/desktop-agent/services/desktop-gateway.js'
import { DesktopEnrollmentService } from '../../src/modules/lumi/desktop-agent/services/enrollment.service.js'
import { registerDesktopAgentDeviceRoutes } from '../../src/routes/lumi-desktop-agent.routes.js'

interface TestKeys {
  privateKey: KeyObject
  publicKey: string
}

function newKeys(): TestKeys {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return { privateKey, publicKey: publicKey.export({ format: 'jwk' }).x as string }
}

function signWith(keys: TestKeys, message: string): string {
  return sign(null, Buffer.from(message, 'utf8'), keys.privateKey).toString('base64url')
}

const deviceInfo = {
  name: 'Portátil',
  os: 'windows' as const,
  os_version: '11 24H2',
  arch: 'x86_64',
  agent_version: '0.1.0',
}

function setup() {
  const devices = new MemoryDesktopDeviceStore()
  const enrollments = new MemoryDesktopEnrollmentStore()
  const registrations = new MemoryPendingRegistrationStore()
  const enrollment = new DesktopEnrollmentService({ devices, enrollments, registrations })
  const gateway = new DesktopGateway({ devices })
  return { devices, enrollments, registrations, enrollment, gateway }
}

async function registerDevice(env: ReturnType<typeof setup>, owner = 'u1', keys = newKeys()) {
  const { code } = await env.enrollment.createEnrollment(owner)
  const installationId = randomUUID()
  const start = await env.enrollment.startRegistration({
    enrollment_code: code,
    installation_id: installationId,
    public_key: keys.publicKey,
    device_info: deviceInfo,
  })
  const done = await env.enrollment.completeRegistration({
    registration_id: start.registration_id,
    signature: signWith(
      keys,
      registrationSigningString(start.challenge, installationId, keys.publicKey),
    ),
  })
  return { deviceId: done.device_id, keys, installationId }
}

/** Mensaje del Server tal como lo recibe el agente (solo los campos que miran las pruebas). */
interface AgentMessage {
  message_type: string
  task_id?: string | null
  device_id: string | null
  correlation_id: string | null
  payload: { nonce: string; connection_id: string } & Record<string, unknown>
}

class FakeSocket implements AgentSocket {
  sent: Array<AgentMessage> = []
  closedWith: { code: number; reason: string } | null = null
  send(data: string) {
    this.sent.push(JSON.parse(data))
  }
  close(code: number, reason: string) {
    this.closedWith = { code, reason }
  }
  last() {
    return this.sent[this.sent.length - 1]!
  }
}

function envelope(type: string, deviceId: string | null, payload: Record<string, unknown> = {}) {
  return JSON.stringify({
    protocol_version: '1.0',
    message_id: randomUUID(),
    message_type: type,
    timestamp: new Date().toISOString(),
    device_id: deviceId,
    task_id: null,
    payload,
  })
}

async function handshake(gateway: DesktopGateway, deviceId: string, keys: TestKeys) {
  const socket = new FakeSocket()
  const handle = gateway.accept(socket)
  await handle.onMessage(
    envelope('session.hello', deviceId, { agent_version: '0.1.0', protocol_versions: ['1.0'] }),
  )
  const challenge = socket.last()
  expect(challenge.message_type).toBe('session.challenge')
  const signature = signWith(
    keys,
    authSigningString(challenge.payload.nonce, deviceId, challenge.payload.connection_id),
  )
  await handle.onMessage(envelope('session.authenticate', deviceId, { signature }))
  return { socket, handle }
}

describe('desktop agent: códigos de inscripción y firmas', () => {
  it('genera códigos legibles XXXXX-XXXXX sin caracteres ambiguos y únicos', () => {
    const codes = new Set(Array.from({ length: 200 }, () => generateEnrollmentCode()))
    expect(codes.size).toBe(200)
    for (const code of codes) expect(code).toMatch(/^[A-HJKMNP-TV-Z2-9]{5}-[A-HJKMNP-TV-Z2-9]{5}$/)
  })

  it('normaliza lo que escribe la persona antes de comparar el hash', () => {
    expect(normalizeEnrollmentCode('abcde-fghjk')).toBe('ABCDEFGHJK')
    expect(hashEnrollmentCode(' abcde fghjk ')).toBe(hashEnrollmentCode('ABCDE-FGHJK'))
  })

  it('verifica firmas Ed25519 y rechaza firmas ajenas o con formato inválido', () => {
    const keys = newKeys()
    const other = newKeys()
    const sig = signWith(keys, 'hola')
    expect(verifyEd25519(keys.publicKey, 'hola', sig)).toBe(true)
    expect(verifyEd25519(keys.publicKey, 'adios', sig)).toBe(false)
    expect(verifyEd25519(other.publicKey, 'hola', sig)).toBe(false)
    expect(verifyEd25519('corta', 'hola', sig)).toBe(false)
    expect(verifyEd25519(keys.publicKey, 'hola', 'AAAA')).toBe(false)
  })
})

describe('desktop agent: registro con prueba de posesión', () => {
  it('crea el equipo para quien generó el código y consume el código', async () => {
    const env = setup()
    const { deviceId, installationId } = await registerDevice(env, 'owner-1')
    const device = await env.devices.findById(deviceId)
    expect(device).toMatchObject({
      ownerUserId: 'owner-1',
      installationId,
      status: 'active',
      name: 'Portátil',
    })
    expect([...env.enrollments.items.values()][0]!.consumedAt).not.toBeNull()
  })

  it('un código no sirve dos veces', async () => {
    const env = setup()
    const { code } = await env.enrollment.createEnrollment('u1')
    const keys = newKeys()
    const installationId = randomUUID()
    const start = await env.enrollment.startRegistration({
      enrollment_code: code,
      installation_id: installationId,
      public_key: keys.publicKey,
      device_info: deviceInfo,
    })
    await env.enrollment.completeRegistration({
      registration_id: start.registration_id,
      signature: signWith(
        keys,
        registrationSigningString(start.challenge, installationId, keys.publicKey),
      ),
    })
    await expect(
      env.enrollment.startRegistration({
        enrollment_code: code,
        installation_id: randomUUID(),
        public_key: newKeys().publicKey,
        device_info: deviceInfo,
      }),
    ).rejects.toMatchObject({ statusCode: 401, code: 'ENROLLMENT_INVALID' })
  })

  it('una firma inválida no registra el equipo ni quema el código', async () => {
    const env = setup()
    const { code } = await env.enrollment.createEnrollment('u1')
    const keys = newKeys()
    const installationId = randomUUID()
    const start = await env.enrollment.startRegistration({
      enrollment_code: code,
      installation_id: installationId,
      public_key: keys.publicKey,
      device_info: deviceInfo,
    })
    await expect(
      env.enrollment.completeRegistration({
        registration_id: start.registration_id,
        signature: signWith(
          newKeys(),
          registrationSigningString(start.challenge, installationId, keys.publicKey),
        ),
      }),
    ).rejects.toMatchObject({ statusCode: 401, code: 'REGISTRATION_INVALID' })
    expect(env.devices.items.size).toBe(0)
    expect(await env.enrollments.findValid(hashEnrollmentCode(code), new Date())).not.toBeNull()
  })

  it('el desafío solo se puede responder una vez', async () => {
    const env = setup()
    const { code } = await env.enrollment.createEnrollment('u1')
    const keys = newKeys()
    const installationId = randomUUID()
    const start = await env.enrollment.startRegistration({
      enrollment_code: code,
      installation_id: installationId,
      public_key: keys.publicKey,
      device_info: deviceInfo,
    })
    const input = {
      registration_id: start.registration_id,
      signature: signWith(
        keys,
        registrationSigningString(start.challenge, installationId, keys.publicKey),
      ),
    }
    await env.enrollment.completeRegistration(input)
    await expect(env.enrollment.completeRegistration(input)).rejects.toBeInstanceOf(AppError)
  })

  it('códigos caducados y desafíos caducados se rechazan', async () => {
    let now = new Date('2026-11-23T10:00:00Z')
    const devices = new MemoryDesktopDeviceStore()
    const enrollments = new MemoryDesktopEnrollmentStore()
    const registrations = new MemoryPendingRegistrationStore()
    const service = new DesktopEnrollmentService({
      devices,
      enrollments,
      registrations,
      now: () => now,
    })
    const { code } = await service.createEnrollment('u1')
    const keys = newKeys()
    const installationId = randomUUID()
    const start = await service.startRegistration({
      enrollment_code: code,
      installation_id: installationId,
      public_key: keys.publicKey,
      device_info: deviceInfo,
    })
    now = new Date(now.getTime() + 61_000)
    await expect(
      service.completeRegistration({
        registration_id: start.registration_id,
        signature: signWith(
          keys,
          registrationSigningString(start.challenge, installationId, keys.publicKey),
        ),
      }),
    ).rejects.toMatchObject({ code: 'REGISTRATION_INVALID' })
    now = new Date(now.getTime() + 10 * 60_000)
    await expect(
      service.startRegistration({
        enrollment_code: code,
        installation_id: installationId,
        public_key: keys.publicKey,
        device_info: deviceInfo,
      }),
    ).rejects.toMatchObject({ code: 'ENROLLMENT_INVALID' })
  })

  it('una instalación activa no se puede registrar dos veces', async () => {
    const env = setup()
    const { keys } = await registerDevice(env)
    const { code } = await env.enrollment.createEnrollment('u1')
    await expect(
      env.enrollment.startRegistration({
        enrollment_code: code,
        installation_id: randomUUID(),
        public_key: keys.publicKey,
        device_info: deviceInfo,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'DEVICE_ALREADY_REGISTERED' })
  })
})

describe('desktop agent: pasarela WebSocket', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }))
  afterEach(() => vi.useRealTimers())

  it('completa hello → challenge → authenticate → ready y marca el equipo en línea', async () => {
    const env = setup()
    const { deviceId, keys } = await registerDevice(env)
    const { socket } = await handshake(env.gateway, deviceId, keys)
    expect(socket.last()).toMatchObject({
      message_type: 'session.ready',
      device_id: deviceId,
      payload: { negotiated_version: '1.2', heartbeat_interval_ms: 25_000 },
    })
    expect(socket.closedWith).toBeNull()
    expect(env.gateway.isOnline(deviceId)).toBe(true)
    expect((await env.devices.findById(deviceId))!.lastSeenAt).not.toBeNull()
  })

  it('rechaza una firma de otra clave con 4401', async () => {
    const env = setup()
    const { deviceId } = await registerDevice(env)
    const { socket } = await handshake(env.gateway, deviceId, newKeys())
    expect(socket.last()).toMatchObject({
      message_type: 'session.error',
      payload: { code: 'AUTHENTICATION_FAILED' },
    })
    expect(socket.closedWith?.code).toBe(CLOSE_CODES.unauthenticated)
    expect(env.gateway.isOnline(deviceId)).toBe(false)
  })

  it('un equipo inexistente recibe desafío igualmente y luego falla (no revela ids)', async () => {
    const env = setup()
    const { socket } = await handshake(env.gateway, 'dev_000000000000000000000000', newKeys())
    expect(socket.sent[0]!.message_type).toBe('session.challenge')
    expect(socket.closedWith?.code).toBe(CLOSE_CODES.unauthenticated)
  })

  it('un equipo revocado que firma bien recibe device.revoked y se cierra con 4403', async () => {
    const env = setup()
    const { deviceId, keys } = await registerDevice(env)
    await env.devices.revoke(deviceId, 'u1', new Date())
    const { socket } = await handshake(env.gateway, deviceId, keys)
    expect(socket.last().message_type).toBe('device.revoked')
    expect(socket.closedWith?.code).toBe(CLOSE_CODES.revoked)
  })

  it('la revocación desde Admin desconecta al agente en línea', async () => {
    const env = setup()
    const { deviceId, keys } = await registerDevice(env)
    const { socket } = await handshake(env.gateway, deviceId, keys)
    env.gateway.disconnectRevoked(deviceId)
    expect(socket.last().message_type).toBe('device.revoked')
    expect(socket.closedWith?.code).toBe(CLOSE_CODES.revoked)
    expect(env.gateway.isOnline(deviceId)).toBe(false)
  })

  it('responde ping con pong correlacionado y guarda estado y capacidades', async () => {
    const env = setup()
    const { deviceId, keys } = await registerDevice(env)
    const { socket, handle } = await handshake(env.gateway, deviceId, keys)
    const ping = envelope('session.ping', deviceId)
    await handle.onMessage(ping)
    expect(socket.last()).toMatchObject({
      message_type: 'session.pong',
      correlation_id: JSON.parse(ping).message_id,
    })

    await handle.onMessage(envelope('device.status', deviceId, { execution: 'paused' }))
    const report = {
      engines: {
        browser: { available: false, reason: 'not_integrated' },
        desktop: { available: false, reason: 'not_integrated' },
      },
      operations: [],
    }
    await handle.onMessage(envelope('capability.report', deviceId, report))
    const device = await env.devices.findById(deviceId)
    expect(device!.execution).toBe('paused')
    expect(device!.capabilities).toEqual(report)
  })

  it('sin servicio de ejecuciones rechaza task.* sin cerrar la conexión', async () => {
    const env = setup()
    const { deviceId, keys } = await registerDevice(env)
    const { socket, handle } = await handshake(env.gateway, deviceId, keys)
    await handle.onMessage(envelope('task.result', deviceId, {}))
    expect(socket.last()).toMatchObject({
      message_type: 'session.error',
      payload: { code: 'OPERATION_NOT_AVAILABLE' },
    })
    expect(socket.closedWith).toBeNull()
  })

  it('entrega las claves de grant en session.ready y enruta task.* al servicio; un agente no puede despachar', async () => {
    const devices = new MemoryDesktopDeviceStore()
    const gateway = new DesktopGateway({
      devices,
      grantKeys: () => [{ kid: 'k1', public_key: 'pub' }],
    })
    const received: Array<{ deviceId: string; type: string }> = []
    const ready: string[] = []
    gateway.setTaskHandler({
      onAgentMessage: async (id, env) => {
        received.push({ deviceId: id, type: env.message_type })
      },
      onDeviceReady: async (id) => {
        ready.push(id)
      },
    })
    const env = { ...setup(), devices, gateway }
    env.enrollment = new DesktopEnrollmentService({
      devices,
      enrollments: new MemoryDesktopEnrollmentStore(),
      registrations: new MemoryPendingRegistrationStore(),
    })
    const { deviceId, keys } = await registerDevice(env)
    const { socket, handle } = await handshake(gateway, deviceId, keys)
    expect(socket.last().payload).toMatchObject({ grant_keys: [{ kid: 'k1', public_key: 'pub' }] })
    expect(ready).toEqual([deviceId])

    await handle.onMessage(envelope('task.result', deviceId, {}))
    expect(received).toEqual([{ deviceId, type: 'task.result' }])
    await handle.onMessage(envelope('task.dispatch', deviceId, {}))
    expect(socket.last()).toMatchObject({
      message_type: 'session.error',
      payload: { code: 'UNEXPECTED_MESSAGE' },
    })
    expect(received).toHaveLength(1)

    expect(gateway.sendTask(deviceId, 'task.cancel', 'exe_1', {})).toBe(true)
    expect(socket.last()).toMatchObject({ message_type: 'task.cancel', task_id: 'exe_1' })
    expect(gateway.sendTask('dev_000000000000000000000000', 'task.cancel', 'exe_1', {})).toBe(false)
  })

  it('los mensajes de transferencia solo pasan con cupo (uno por petición del Server) y avisan de la desconexión', async () => {
    const devices = new MemoryDesktopDeviceStore()
    const gateway = new DesktopGateway({ devices, grantKeys: () => [] })
    let transferMessages = 0
    const disconnected: string[] = []
    gateway.setTaskHandler({
      onAgentMessage: async (_id, env) => {
        if (env.message_type.startsWith('transfer.')) transferMessages += 1
      },
      onDeviceReady: async () => undefined,
      onDeviceDisconnected: async (id) => {
        disconnected.push(id)
      },
    })
    const env = { ...setup(), devices, gateway }
    env.enrollment = new DesktopEnrollmentService({
      devices,
      enrollments: new MemoryDesktopEnrollmentStore(),
      registrations: new MemoryPendingRegistrationStore(),
    })
    const { deviceId, keys } = await registerDevice(env)
    const { socket, handle } = await handshake(gateway, deviceId, keys)
    const data = () => envelope('transfer.data', deviceId, { offset: 0, data: '', eof: false })

    // 200 bloques solicitados: muy por encima del límite general de 60 mensajes por ventana.
    for (let i = 0; i < 200; i++) {
      gateway.sendTask(deviceId, 'transfer.read', 'exe_1', { offset: i, length: 1 })
      await handle.onMessage(data())
    }
    expect(transferMessages).toBe(200)
    expect(socket.closedWith).toBeNull()

    // Uno más sin petición: se cierra como cualquier exceso.
    await handle.onMessage(data())
    expect(socket.closedWith?.code).toBe(4429)
    expect(transferMessages).toBe(200)
    expect(disconnected).toEqual([deviceId])
  })

  it('una conexión nueva del mismo equipo sustituye a la anterior (4409)', async () => {
    const env = setup()
    const { deviceId, keys } = await registerDevice(env)
    const first = await handshake(env.gateway, deviceId, keys)
    const second = await handshake(env.gateway, deviceId, keys)
    expect(first.socket.closedWith?.code).toBe(CLOSE_CODES.replaced)
    first.handle.onClose()
    expect(second.socket.closedWith).toBeNull()
    expect(env.gateway.isOnline(deviceId)).toBe(true)
  })

  it('cierra mensajes malformados (4400), protocolos incompatibles (4426) y mensajes de otro equipo', async () => {
    const env = setup()
    const a = new FakeSocket()
    await env.gateway.accept(a).onMessage('{no json')
    expect(a.closedWith?.code).toBe(CLOSE_CODES.malformed)

    const b = new FakeSocket()
    await env.gateway
      .accept(b)
      .onMessage(
        envelope('session.hello', 'dev_x', { agent_version: '9', protocol_versions: ['2.0'] }),
      )
    expect(b.closedWith?.code).toBe(CLOSE_CODES.protocolUnsupported)

    const { deviceId, keys } = await registerDevice(env)
    const c = await handshake(env.gateway, deviceId, keys)
    await c.handle.onMessage(envelope('session.ping', 'dev_otro'))
    expect(c.socket.closedWith?.code).toBe(CLOSE_CODES.malformed)
  })

  it('cierra por falta de autenticación y por falta de latido', async () => {
    const env = setup()
    const idle = new FakeSocket()
    env.gateway.accept(idle)
    await vi.advanceTimersByTimeAsync(10_001)
    expect(idle.closedWith?.code).toBe(CLOSE_CODES.unauthenticated)

    const { deviceId, keys } = await registerDevice(env)
    const { socket } = await handshake(env.gateway, deviceId, keys)
    await vi.advanceTimersByTimeAsync(HEARTBEAT_TIMEOUT_MS + 1)
    expect(socket.closedWith?.code).toBe(CLOSE_CODES.heartbeatTimeout)
    expect(env.gateway.isOnline(deviceId)).toBe(false)
  })
})

describe('desktop agent: rutas HTTP y WebSocket reales', () => {
  it('registra por HTTP y autentica por WebSocket', async () => {
    const env = setup()
    const app = Fastify()
    await registerDesktopAgentDeviceRoutes(app, { ...env, clientIp: (request) => request.ip })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    try {
      const { code } = await env.enrollment.createEnrollment('u1')
      const keys = newKeys()
      const installationId = randomUUID()
      const start = await app.inject({
        method: 'POST',
        url: '/desktop-agent/registrations/start',
        payload: {
          enrollment_code: code,
          installation_id: installationId,
          public_key: keys.publicKey,
          device_info: deviceInfo,
        },
      })
      expect(start.statusCode).toBe(201)
      const { registration_id, challenge } = start.json()
      const complete = await app.inject({
        method: 'POST',
        url: '/desktop-agent/registrations/complete',
        payload: {
          registration_id,
          signature: signWith(
            keys,
            registrationSigningString(challenge, installationId, keys.publicKey),
          ),
        },
      })
      expect(complete.statusCode).toBe(201)
      const deviceId = complete.json().device_id as string

      const bad = await app.inject({
        method: 'POST',
        url: '/desktop-agent/registrations/start',
        payload: { enrollment_code: 'x' },
      })
      expect(bad.statusCode).toBeGreaterThanOrEqual(400)

      const ws = new WebSocket(`${address.replace('http', 'ws')}/desktop-agent/ws`)
      await new Promise((resolve, reject) => {
        ws.once('open', resolve)
        ws.once('error', reject)
      })
      const received: Array<AgentMessage> = []
      const next = () =>
        new Promise<AgentMessage>((resolve) => {
          ws.once('message', (data) => {
            const msg = JSON.parse(data.toString())
            received.push(msg)
            resolve(msg)
          })
        })
      let pending = next()
      ws.send(
        envelope('session.hello', deviceId, { agent_version: '0.1.0', protocol_versions: ['1.0'] }),
      )
      const ch = await pending
      expect(ch.message_type).toBe('session.challenge')
      pending = next()
      ws.send(
        envelope('session.authenticate', deviceId, {
          signature: signWith(
            keys,
            authSigningString(ch.payload.nonce, deviceId, ch.payload.connection_id),
          ),
        }),
      )
      expect((await pending).message_type).toBe('session.ready')
      expect(env.gateway.isOnline(deviceId)).toBe(true)
      ws.terminate()
    } finally {
      await app.close()
    }
  })
})

describe('desktop agent: contrato compartido con lumia-desktop-agent', () => {
  const examplesDir = new URL('../../../lumia-desktop-agent/protocol/examples/', import.meta.url)
  const available = existsSync(examplesDir)

  it.skipIf(!available)(
    'los ejemplos del protocolo cumplen el sobre y las cargas del Server',
    () => {
      const files = readdirSync(examplesDir).filter((f) => f.endsWith('.json'))
      expect(files.length).toBeGreaterThan(0)
      for (const file of files) {
        const message = JSON.parse(readFileSync(new URL(file, examplesDir), 'utf8'))
        expect(envelopeSchema.safeParse(message).success, file).toBe(true)
      }
      const read = (name: string) =>
        JSON.parse(readFileSync(new URL(name, examplesDir), 'utf8')).payload
      expect(helloPayloadSchema.safeParse(read('session.hello.json')).success).toBe(true)
      expect(capabilityReportPayloadSchema.safeParse(read('capability.report.json')).success).toBe(
        true,
      )
      expect(taskStatePayloadSchema.safeParse(read('task.state.json')).success).toBe(true)
      expect(taskResultPayloadSchema.safeParse(read('task.result.json')).success).toBe(true)
      expect(transferOpenPayloadSchema.safeParse(read('transfer.open.json')).success).toBe(true)
      expect(transferDataPayloadSchema.safeParse(read('transfer.data.json')).success).toBe(true)
      expect(transferAckPayloadSchema.safeParse(read('transfer.ack.json')).success).toBe(true)
    },
  )
})

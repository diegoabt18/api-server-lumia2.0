import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PERMISSION_REGISTRY as P,
  type PermissionId,
} from '../../src/common/permissions/registry.js'
import {
  verifyEd25519,
  type DesktopDevice,
} from '../../src/modules/lumi/desktop-agent/domain/device.js'
import type { Envelope } from '../../src/modules/lumi/desktop-agent/domain/protocol.js'
import { MemoryDesktopDeviceStore } from '../../src/modules/lumi/desktop-agent/infrastructure/desktop-device.repository.js'
import { MemoryDesktopExecutionStore } from '../../src/modules/lumi/desktop-agent/infrastructure/desktop-execution.repository.js'
import { GrantSigner } from '../../src/modules/lumi/desktop-agent/infrastructure/grant-signer.js'
import {
  DesktopExecutionService,
  type TaskTransport,
} from '../../src/modules/lumi/desktop-agent/services/execution.service.js'

const DEVICE = 'dev_0123456789abcdef01234567'
const ALL_BROWSER_OPS = [
  'browser.discover',
  'browser.navigate',
  'browser.snapshot',
  'browser.click',
  'browser.fill',
  'browser.scroll',
  'browser.tabs.list',
  'browser.close_session',
]

interface Sent {
  deviceId: string
  type: string
  taskId: string
  payload: Record<string, unknown>
}

class FakeTransport implements TaskTransport {
  online = new Set<string>([DEVICE])
  sent: Sent[] = []
  isOnline(deviceId: string) {
    return this.online.has(deviceId)
  }
  sendTask(deviceId: string, type: string, taskId: string, payload: Record<string, unknown>) {
    this.sent.push({ deviceId, type, taskId, payload })
    return this.online.has(deviceId)
  }
  last(type: string) {
    return [...this.sent].reverse().find((s) => s.type === type)
  }
}

function device(overrides: Partial<DesktopDevice> = {}): DesktopDevice {
  return {
    id: DEVICE,
    ownerUserId: 'owner',
    installationId: randomUUID(),
    publicKey: 'x'.repeat(43),
    name: 'PC',
    os: 'windows',
    osVersion: '10.0.26200',
    arch: 'x86_64',
    agentVersion: '0.2.0',
    status: 'active',
    execution: 'active',
    capabilities: {
      engines: {
        browser: { available: true, reason: null },
        desktop: { available: false, reason: 'not_integrated' },
      },
      operations: ALL_BROWSER_OPS,
    },
    registeredAt: new Date(),
    revokedAt: null,
    lastSeenAt: new Date(),
    ...overrides,
  }
}

async function setup(dev: DesktopDevice = device()) {
  const devices = new MemoryDesktopDeviceStore()
  await devices.insert(dev)
  const executions = new MemoryDesktopExecutionStore()
  const signer = new GrantSigner(Buffer.alloc(32, 7))
  const transport = new FakeTransport()
  const service = new DesktopExecutionService({ devices, executions, signer, transport })
  return { devices, executions, signer, transport, service }
}

const CONTROL: PermissionId[] = [P.ADMIN_ACCESS, P.DESKTOP_BROWSER_READ, P.DESKTOP_BROWSER_CONTROL]
/** Comodín de permisos (rol con todo). */
const WILDCARD = ['*'] as unknown as PermissionId[]
const READ_ONLY: PermissionId[] = [P.ADMIN_ACCESS, P.DESKTOP_BROWSER_READ]

function agentMessage(type: string, taskId: string, payload: Record<string, unknown>): Envelope {
  return {
    protocol_version: '1.1',
    message_id: randomUUID(),
    message_type: type,
    timestamp: new Date().toISOString(),
    device_id: DEVICE,
    task_id: taskId,
    payload,
  }
}

function decodeClaims(grant: string) {
  return JSON.parse(Buffer.from(grant.split('.')[1]!, 'base64url').toString('utf8'))
}

/** Espera a que el servicio haya enviado el despacho (la validación es asíncrona). */
async function dispatched(transport: FakeTransport) {
  await vi.waitFor(() => expect(transport.last('task.dispatch')).toBeDefined())
  return transport.last('task.dispatch')!
}

describe('desktop agent: autorización de ejecuciones en el Server', () => {
  it('rechaza operaciones fuera del catálogo, sin permiso o con argumentos inválidos', async () => {
    const { service } = await setup()
    const base = { userId: 'owner', deviceId: DEVICE }
    await expect(
      service.dispatch({ ...base, permissionKeys: WILDCARD, operation: 'shell.exec', args: {} }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'UNKNOWN_OPERATION',
    })
    await expect(
      service.dispatch({
        ...base,
        permissionKeys: READ_ONLY,
        operation: 'browser.navigate',
        args: { url: 'https://e.com' },
      }),
    ).rejects.toMatchObject({ statusCode: 403 })
    for (const args of [
      { url: 'file:///C:/Windows/win.ini' },
      { url: 'https://u:p@e.com' },
      { url: 'https://e.com', extra: 1 },
    ]) {
      await expect(
        service.dispatch({ ...base, permissionKeys: CONTROL, operation: 'browser.navigate', args }),
      ).rejects.toMatchObject({
        statusCode: 400,
      })
    }
    await expect(
      service.dispatch({
        ...base,
        permissionKeys: CONTROL,
        operation: 'browser.click',
        args: { ref: 'e1; rm -rf' },
      }),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('solo el dueño puede ordenar operaciones en su equipo (404 para los demás, aunque tengan *)', async () => {
    const { service, transport } = await setup()
    await expect(
      service.dispatch({
        userId: 'intruso',
        permissionKeys: WILDCARD,
        deviceId: DEVICE,
        operation: 'browser.discover',
        args: {},
      }),
    ).rejects.toMatchObject({ statusCode: 404 })
    expect(transport.sent).toHaveLength(0)
  })

  it('exige equipo activo, conectado, sin pausa y que anuncie la operación', async () => {
    const cases: Array<[Partial<DesktopDevice>, string]> = [
      [{ status: 'revoked' }, 'DEVICE_REVOKED'],
      [{ execution: 'paused' }, 'DEVICE_PAUSED'],
      [
        {
          capabilities: {
            engines: {
              browser: { available: false, reason: 'engine_binary_missing' },
              desktop: { available: false, reason: null },
            },
            operations: ['browser.discover'],
          },
        },
        'OPERATION_NOT_SUPPORTED',
      ],
    ]
    for (const [overrides, code] of cases) {
      const { service } = await setup(device(overrides))
      await expect(
        service.dispatch({
          userId: 'owner',
          permissionKeys: CONTROL,
          deviceId: DEVICE,
          operation: 'browser.navigate',
          args: { url: 'https://e.com' },
        }),
      ).rejects.toMatchObject({ statusCode: 409, code })
    }
    const { service, transport } = await setup()
    transport.online.clear()
    await expect(
      service.dispatch({
        userId: 'owner',
        permissionKeys: CONTROL,
        deviceId: DEVICE,
        operation: 'browser.discover',
        args: {},
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'DEVICE_OFFLINE' })
  })
})

describe('desktop agent: ciclo de una ejecución', () => {
  it('firma un grant de un solo uso para ese equipo, tarea y argumentos, y devuelve el resultado verificado', async () => {
    const { service, transport, signer, executions } = await setup()
    const pending = service.dispatch({
      userId: 'owner',
      permissionKeys: CONTROL,
      deviceId: DEVICE,
      operation: 'browser.navigate',
      args: { url: 'https://example.com/privado?token=secreto' },
    })
    const sent = await dispatched(transport)
    const grant = sent.payload.grant as string
    const [h, b, s] = grant.split('.')
    expect(verifyEd25519(signer.key.public_key, `${h}.${b}`, s!)).toBe(true)
    const claims = decodeClaims(grant)
    expect(claims).toMatchObject({
      iss: 'lumia-server',
      aud: DEVICE,
      task_id: sent.taskId,
      sub: 'owner',
      op: 'browser.navigate',
      args: { url: 'https://example.com/privado?token=secreto' },
    })
    expect(claims.exp - claims.iat).toBe(120)
    expect(claims.jti).toMatch(/^auth_/)

    await service.onAgentMessage(
      DEVICE,
      agentMessage('task.state', sent.taskId, { state: 'running' }),
    )
    expect((await executions.findById(sent.taskId))!.status).toBe('running')
    const result = { url: 'https://example.com/privado', title: 'Ejemplo' }
    await service.onAgentMessage(
      DEVICE,
      agentMessage('task.result', sent.taskId, {
        status: 'completed',
        operation: 'browser.navigate',
        verification: { verified: true, method: 'browser.current_url' },
        result,
        error: null,
        duration_ms: 1250,
      }),
    )
    const outcome = await pending
    expect(outcome.result).toEqual(result)
    expect(outcome.execution).toMatchObject({
      status: 'completed',
      durationMs: 1250,
      verification: { verified: true },
    })
    expect(transport.last('task.result.ack')?.taskId).toBe(sent.taskId)

    // El registro no guarda el resultado ni la ruta/query de la URL.
    const stored = JSON.stringify(await executions.findById(sent.taskId))
    expect(stored).not.toContain('Ejemplo')
    expect(stored).not.toContain('token')
    expect(stored).toContain('https://example.com')
  })

  it('no guarda el texto escrito en un campo, solo su longitud', async () => {
    const { service, transport, executions } = await setup()
    void service.dispatch({
      userId: 'owner',
      permissionKeys: CONTROL,
      deviceId: DEVICE,
      operation: 'browser.fill',
      args: { ref: 'e3', value: 'mi contraseña' },
    })
    const sent = await dispatched(transport)
    const stored = await executions.findById(sent.taskId)
    expect(stored!.argsSummary).toEqual({ ref: 'e3', value_length: 13 })
    expect(JSON.stringify(stored)).not.toContain('contraseña')
  })

  it('un equipo no puede informar de la tarea de otro', async () => {
    const { service, transport, executions } = await setup()
    void service.dispatch({
      userId: 'owner',
      permissionKeys: CONTROL,
      deviceId: DEVICE,
      operation: 'browser.discover',
      args: {},
    })
    const sent = await dispatched(transport)
    await service.onAgentMessage('dev_ffffffffffffffffffffffff', {
      ...agentMessage('task.result', sent.taskId, {
        status: 'completed',
        operation: 'browser.discover',
        verification: null,
        result: {},
        error: null,
        duration_ms: 1,
      }),
      device_id: 'dev_ffffffffffffffffffffffff',
    })
    expect((await executions.findById(sent.taskId))!.status).toBe('dispatched')
  })

  it('un resultado malformado cierra la ejecución como fallida', async () => {
    const { service, transport } = await setup()
    const pending = service.dispatch({
      userId: 'owner',
      permissionKeys: CONTROL,
      deviceId: DEVICE,
      operation: 'browser.discover',
      args: {},
    })
    const sent = await dispatched(transport)
    await service.onAgentMessage(
      DEVICE,
      agentMessage('task.result', sent.taskId, { status: 'éxito total' }),
    )
    const outcome = await pending
    expect(outcome.execution.status).toBe('failed')
    expect(outcome.execution.error?.code).toBe('AGENT_PROTOCOL_ERROR')
    expect(outcome.result).toBeNull()
  })

  it('cancelar envía task.cancel; solo puede hacerlo quien la ordenó', async () => {
    const { service, transport } = await setup()
    void service.dispatch({
      userId: 'owner',
      permissionKeys: CONTROL,
      deviceId: DEVICE,
      operation: 'browser.snapshot',
      args: {},
    })
    const sent = await dispatched(transport)
    await expect(service.cancel(sent.taskId, 'otro', CONTROL)).rejects.toMatchObject({
      statusCode: 404,
    })
    const view = await service.cancel(sent.taskId, 'owner', CONTROL)
    expect(view.cancelRequested).toBe(true)
    expect(transport.last('task.cancel')?.taskId).toBe(sent.taskId)
  })
})

describe('desktop agent: tiempos y reconexiones', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }))
  afterEach(() => vi.useRealTimers())

  it('sin resultado a tiempo la ejecución termina como timed_out y un resultado tardío no la cambia', async () => {
    const { service, transport, executions } = await setup()
    const pending = service.dispatch({
      userId: 'owner',
      permissionKeys: CONTROL,
      deviceId: DEVICE,
      operation: 'browser.discover',
      args: {},
      timeoutMs: 5_000,
    })
    const sent = await dispatched(transport)
    await vi.advanceTimersByTimeAsync(5_000 + 15_000 + 1)
    const outcome = await pending
    expect(outcome.execution.status).toBe('timed_out')
    expect(outcome.result).toBeNull()
    await service.onAgentMessage(
      DEVICE,
      agentMessage('task.result', sent.taskId, {
        status: 'completed',
        operation: 'browser.discover',
        verification: null,
        result: {},
        error: null,
        duration_ms: 1,
      }),
    )
    expect((await executions.findById(sent.taskId))!.status).toBe('timed_out')
  })

  it('tras reconectar reenvía el despacho no entregado con el mismo grant, o lo caduca si venció', async () => {
    const { service, transport, executions } = await setup()
    void service.dispatch({
      userId: 'owner',
      permissionKeys: CONTROL,
      deviceId: DEVICE,
      operation: 'browser.discover',
      args: {},
    })
    const first = await dispatched(transport)
    await service.onDeviceReady(DEVICE)
    const resent = transport.sent.filter((s) => s.type === 'task.dispatch')
    expect(resent).toHaveLength(2)
    expect(resent[1]!.payload.grant).toBe(first.payload.grant)

    await vi.advanceTimersByTimeAsync(121_000)
    await service.onDeviceReady(DEVICE)
    const final = await executions.findById(first.taskId)
    expect(['failed', 'timed_out']).toContain(final!.status)
  })

  it('una vez recibido por el agente no se reenvía', async () => {
    const { service, transport } = await setup()
    void service.dispatch({
      userId: 'owner',
      permissionKeys: CONTROL,
      deviceId: DEVICE,
      operation: 'browser.discover',
      args: {},
    })
    const sent = await dispatched(transport)
    await service.onAgentMessage(
      DEVICE,
      agentMessage('task.state', sent.taskId, { state: 'received' }),
    )
    await service.onDeviceReady(DEVICE)
    expect(transport.sent.filter((s) => s.type === 'task.dispatch')).toHaveLength(1)
  })
})

describe('desktop agent: operaciones de aplicaciones (fase 3)', () => {
  const APPS: PermissionId[] = [P.ADMIN_ACCESS, P.DESKTOP_APPS_READ, P.DESKTOP_APPS_CONTROL]
  const deviceWithApps = () =>
    device({
      capabilities: {
        engines: {
          browser: { available: true, reason: null },
          desktop: { available: true, reason: null },
        },
        operations: [
          ...ALL_BROWSER_OPS,
          'desktop.status',
          'desktop.list_applications',
          'desktop.list_windows',
          'desktop.snapshot',
          'desktop.click',
          'desktop.set_value',
          'desktop.get_value',
          'desktop.press_key',
        ],
      },
    })
  const base = { userId: 'owner', deviceId: DEVICE }

  it('solo acepta teclas de navegación y edición, normalizadas', async () => {
    const { service, transport } = await setup(deviceWithApps())
    for (const key of ['win+r', 'alt+f4', 'ctrl+alt+delete', 'cmd+q', 'alt+tab', 'f5']) {
      await expect(
        service.dispatch({
          ...base,
          permissionKeys: APPS,
          operation: 'desktop.press_key',
          args: { app: 'App.exe', key },
        }),
      ).rejects.toMatchObject({ statusCode: 400 })
    }
    void service.dispatch({
      ...base,
      permissionKeys: APPS,
      operation: 'desktop.press_key',
      args: { app: 'App.exe', key: ' Enter ' },
    })
    const sent = await dispatched(transport)
    expect(decodeClaims(sent.payload.grant as string).args).toEqual({
      app: 'App.exe',
      key: 'enter',
    })
  })

  it('rechaza nombres de aplicación con rutas u opciones y refs mal formadas', async () => {
    const { service } = await setup(deviceWithApps())
    for (const app of [
      '--force',
      String.raw`C:\Windows\System32\cmd.exe`,
      'a/b',
      '',
      'x'.repeat(129),
    ]) {
      await expect(
        service.dispatch({
          ...base,
          permissionKeys: APPS,
          operation: 'desktop.snapshot',
          args: { app },
        }),
      ).rejects.toMatchObject({ statusCode: 400 })
    }
    for (const ref of ['e3', '@e3', '@s8f3k2p9:x3', '--force']) {
      await expect(
        service.dispatch({
          ...base,
          permissionKeys: APPS,
          operation: 'desktop.click',
          args: { ref },
        }),
      ).rejects.toMatchObject({ statusCode: 400 })
    }
  })

  it('los permisos de navegador no sirven para aplicaciones ni al revés', async () => {
    const { service } = await setup(deviceWithApps())
    await expect(
      service.dispatch({
        ...base,
        permissionKeys: CONTROL,
        operation: 'desktop.snapshot',
        args: { app: 'App.exe' },
      }),
    ).rejects.toMatchObject({ statusCode: 403 })
    await expect(
      service.dispatch({
        ...base,
        permissionKeys: [P.ADMIN_ACCESS, P.DESKTOP_APPS_READ],
        operation: 'desktop.click',
        args: { ref: '@s8f3k2p9:e3' },
      }),
    ).rejects.toMatchObject({ statusCode: 403 })
    await expect(
      service.dispatch({
        ...base,
        permissionKeys: APPS,
        operation: 'browser.navigate',
        args: { url: 'https://e.com' },
      }),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('exige que el equipo anuncie el motor de escritorio', async () => {
    const { service } = await setup()
    await expect(
      service.dispatch({
        ...base,
        permissionKeys: APPS,
        operation: 'desktop.snapshot',
        args: { app: 'App.exe' },
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'OPERATION_NOT_SUPPORTED' })
  })

  it('no guarda lo escrito en una aplicación, solo su longitud', async () => {
    const { service, transport, executions } = await setup(deviceWithApps())
    void service.dispatch({
      ...base,
      permissionKeys: APPS,
      operation: 'desktop.set_value',
      args: { ref: '@s8f3k2p9:e1', value: 'texto privado' },
    })
    const sent = await dispatched(transport)
    const stored = await executions.findById(sent.taskId)
    expect(stored!.argsSummary).toEqual({ ref: '@s8f3k2p9:e1', value_length: 13 })
    expect(JSON.stringify(stored)).not.toContain('privado')
  })
})

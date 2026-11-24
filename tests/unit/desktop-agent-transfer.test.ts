import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  PERMISSION_REGISTRY as P,
  type PermissionId,
} from '../../src/common/permissions/registry.js'
import type { DesktopDevice } from '../../src/modules/lumi/desktop-agent/domain/device.js'
import type { Envelope } from '../../src/modules/lumi/desktop-agent/domain/protocol.js'
import { MemoryDesktopDeviceStore } from '../../src/modules/lumi/desktop-agent/infrastructure/desktop-device.repository.js'
import { MemoryDesktopExecutionStore } from '../../src/modules/lumi/desktop-agent/infrastructure/desktop-execution.repository.js'
import { GrantSigner } from '../../src/modules/lumi/desktop-agent/infrastructure/grant-signer.js'
import {
  DesktopExecutionService,
  type TaskTransport,
} from '../../src/modules/lumi/desktop-agent/services/execution.service.js'
import {
  DesktopTransferService,
  type DownloadSink,
} from '../../src/modules/lumi/desktop-agent/services/transfer.service.js'

const DEVICE = 'dev_0123456789abcdef01234567'
const ROOT = 'root_0123456789ab'
const FILES_OPS = ['files.roots', 'files.list', 'files.download', 'files.upload']
const KEYS: PermissionId[] = [P.ADMIN_ACCESS, P.DESKTOP_FILES_READ, P.DESKTOP_FILES_WRITE]
const CHUNK = 256 * 1024

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const bytes = (n: number) => Buffer.from(Array.from({ length: n }, (_, i) => i % 251))

function claimsOf(grant: string) {
  return JSON.parse(Buffer.from(grant.split('.')[1]!, 'base64url').toString('utf8'))
}

/**
 * Agente simulado: responde a `task.dispatch` y a los mensajes de transferencia como el agente real
 * (crates/engine-files), con un archivo en memoria. `corrupt` altera el primer bloque enviado.
 */
class FakeAgent implements TaskTransport {
  service!: DesktopExecutionService
  sent: Array<{ type: string; taskId: string; payload: Record<string, unknown> }> = []
  files = new Map<string, Buffer>()
  received = new Map<string, Buffer>()
  corrupt = false
  rejectWith: string | null = null
  private tasks = new Map<string, { op: string; args: Record<string, unknown>; chunks: Buffer[] }>()

  isOnline() {
    return true
  }

  sendTask(_deviceId: string, type: string, taskId: string, payload: Record<string, unknown>) {
    this.sent.push({ type, taskId, payload })
    setImmediate(() => void this.react(type, taskId, payload))
    return true
  }

  private reply(type: string, taskId: string, payload: Record<string, unknown>) {
    const envelope: Envelope = {
      protocol_version: '1.2',
      message_id: randomUUID(),
      message_type: type,
      timestamp: new Date().toISOString(),
      device_id: DEVICE,
      task_id: taskId,
      payload,
    }
    return this.service.onAgentMessage(DEVICE, envelope)
  }

  private result(taskId: string, op: string, status: string, error: { code: string } | null) {
    return this.reply('task.result', taskId, {
      status,
      operation: op,
      verification: status === 'completed' ? { verified: true, method: 'sha256' } : null,
      result: status === 'completed' ? { ok: true } : null,
      error: error ? { ...error, message: error.code, retryable: false } : null,
      duration_ms: 1,
    })
  }

  private async react(type: string, taskId: string, payload: Record<string, unknown>) {
    if (type === 'task.dispatch') {
      const claims = claimsOf(String(payload.grant))
      this.tasks.set(taskId, { op: claims.op, args: claims.args, chunks: [] })
      if (this.rejectWith)
        return this.result(taskId, claims.op, 'rejected', { code: this.rejectWith })
      if (claims.op === 'files.download') {
        const file = this.files.get(claims.args.path)
        if (!file) return this.result(taskId, claims.op, 'failed', { code: 'FILE_NOT_FOUND' })
        return this.reply('transfer.open', taskId, {
          name: claims.args.path,
          size: file.length,
          sha256: sha(file),
        })
      }
      if (claims.op === 'files.upload') {
        return this.reply('transfer.open', taskId, {
          name: claims.args.name,
          size: claims.args.size,
          sha256: claims.args.sha256,
        })
      }
      return this.result(taskId, claims.op, 'completed', null)
    }
    const task = this.tasks.get(taskId)
    if (!task) return
    if (type === 'task.cancel')
      return this.result(taskId, task.op, 'cancelled', { code: 'CANCELLED' })
    if (type === 'transfer.read') {
      const file = this.files.get(task.args.path as string)!
      const offset = payload.offset as number
      let chunk = file.subarray(offset, offset + (payload.length as number))
      if (this.corrupt && offset === 0) chunk = Buffer.from(chunk.map((b) => b ^ 1))
      return this.reply('transfer.data', taskId, {
        offset,
        data: chunk.toString('base64'),
        eof: offset + chunk.length >= file.length,
      })
    }
    if (type === 'transfer.write') {
      const data = Buffer.from(String(payload.data), 'base64')
      task.chunks.push(data)
      return this.reply('transfer.ack', taskId, { offset: payload.offset, length: data.length })
    }
    if (type === 'transfer.commit') {
      if (task.op === 'files.upload') {
        const all = Buffer.concat(task.chunks)
        if (sha(all) !== task.args.sha256) {
          return this.result(taskId, task.op, 'failed', { code: 'INTEGRITY_FAILED' })
        }
        this.received.set(task.args.name as string, all)
      }
      return this.result(taskId, task.op, 'completed', null)
    }
  }
}

function fileDevice(): DesktopDevice {
  return {
    id: DEVICE,
    ownerUserId: 'owner',
    installationId: randomUUID(),
    publicKey: 'x'.repeat(43),
    name: 'PC',
    os: 'windows',
    osVersion: '10.0.26200',
    arch: 'x86_64',
    agentVersion: '0.3.0',
    status: 'active',
    execution: 'active',
    capabilities: {
      engines: {
        browser: { available: false, reason: null },
        desktop: { available: false, reason: null },
      },
      operations: FILES_OPS,
    },
    registeredAt: new Date(),
    revokedAt: null,
    lastSeenAt: new Date(),
  }
}

async function setup() {
  const devices = new MemoryDesktopDeviceStore()
  await devices.insert(fileDevice())
  const executions = new MemoryDesktopExecutionStore()
  const agent = new FakeAgent()
  const service = new DesktopExecutionService({
    devices,
    executions,
    signer: new GrantSigner(Buffer.alloc(32, 9)),
    transport: agent,
  })
  agent.service = service
  return { agent, service, transfers: new DesktopTransferService(service), executions }
}

function memorySink() {
  const sink = {
    info: null as null | { name: string; size: number; sha256: string },
    chunks: [] as Buffer[],
    ended: false,
    aborted: false,
  }
  const api: DownloadSink = {
    start: (info) => (sink.info = info),
    write: async (chunk) => void sink.chunks.push(Buffer.from(chunk)),
    end: () => (sink.ended = true),
    abort: () => (sink.aborted = true),
  }
  return { sink, api }
}

async function* body(data: Buffer, piece = 100_000) {
  for (let i = 0; i < data.length; i += piece) yield data.subarray(i, i + piece)
}

const target = (keys = KEYS) => ({ userId: 'owner', permissionKeys: keys, deviceId: DEVICE })

describe('desktop agent: transferencias de archivos (fase 6)', () => {
  it('descarga: retransmite por bloques en orden, comprueba el SHA-256 y termina la tarea', async () => {
    const { agent, transfers } = await setup()
    const data = bytes(2 * CHUNK + 123)
    agent.files.set('docs/informe.pdf', data)
    const { sink, api } = memorySink()
    const out = await transfers.download(target(), { root: ROOT, path: 'docs/informe.pdf' }, api)
    expect(out.execution.status).toBe('completed')
    expect(sink.info).toEqual({ name: 'docs/informe.pdf', size: data.length, sha256: sha(data) })
    expect(Buffer.concat(sink.chunks).equals(data)).toBe(true)
    expect(sink.ended).toBe(true)
    const reads = agent.sent.filter((s) => s.type === 'transfer.read')
    expect(reads.map((r) => r.payload)).toEqual([
      { offset: 0, length: CHUNK },
      { offset: CHUNK, length: CHUNK },
      { offset: 2 * CHUNK, length: 123 },
    ])
    expect(agent.sent.some((s) => s.type === 'transfer.commit')).toBe(true)
    // El registro guarda solo la extensión, nunca el nombre ni la ruta.
    expect(out.execution.argsSummary).toEqual({ root: ROOT, ext: 'pdf' })
  })

  it('descarga: si los bytes no coinciden con el hash anunciado, corta y cancela sin commit', async () => {
    const { agent, transfers } = await setup()
    agent.files.set('a.bin', bytes(1000))
    agent.corrupt = true
    const { sink, api } = memorySink()
    await expect(
      transfers.download(target(), { root: ROOT, path: 'a.bin' }, api),
    ).rejects.toMatchObject({
      code: 'INTEGRITY_FAILED',
    })
    expect(sink.aborted).toBe(true)
    expect(sink.ended).toBe(false)
    expect(agent.sent.some((s) => s.type === 'transfer.commit')).toBe(false)
    expect(agent.sent.some((s) => s.type === 'task.cancel')).toBe(true)
  })

  it('descarga: un rechazo del agente (ruta fuera de la carpeta) es un error antes de responder', async () => {
    const { agent, transfers } = await setup()
    agent.rejectWith = 'PATH_NOT_ALLOWED'
    const { sink, api } = memorySink()
    await expect(
      transfers.download(target(), { root: ROOT, path: 'x.txt' }, api),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'PATH_NOT_ALLOWED',
    })
    expect(sink.info).toBeNull()
  })

  it('subida: envía en orden, espera cada acuse y el agente recibe exactamente los bytes', async () => {
    const { agent, transfers } = await setup()
    const data = bytes(CHUNK + 5000)
    const out = await transfers.upload(
      target(),
      { root: ROOT, dir: 'docs', name: 'nuevo.bin', size: data.length, sha256: sha(data) },
      body(data),
    )
    expect(out.execution.status).toBe('completed')
    expect(agent.received.get('nuevo.bin')?.equals(data)).toBe(true)
    const writes = agent.sent.filter((s) => s.type === 'transfer.write')
    expect(writes.map((w) => w.payload.offset)).toEqual([0, CHUNK])
    expect(out.execution.argsSummary).toEqual({ root: ROOT, ext: 'bin', size: data.length })
  })

  it('subida: cuerpo mayor que lo declarado o con otro hash se cancela antes del commit', async () => {
    const { agent, transfers } = await setup()
    const data = bytes(10_000)
    await expect(
      transfers.upload(
        target(),
        { root: ROOT, dir: '', name: 'a.bin', size: 5_000, sha256: sha(data) },
        body(data),
      ),
    ).rejects.toMatchObject({ code: 'SIZE_MISMATCH' })
    await expect(
      transfers.upload(
        target(),
        { root: ROOT, dir: '', name: 'b.bin', size: data.length, sha256: 'f'.repeat(64) },
        body(data),
      ),
    ).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
    expect(agent.sent.some((s) => s.type === 'transfer.commit')).toBe(false)
    expect(agent.sent.filter((s) => s.type === 'task.cancel')).toHaveLength(2)
    expect(agent.received.size).toBe(0)
  })

  it('sin desktop.files.write no se firma ni se envía nada; rutas con .. se rechazan en el Server', async () => {
    const { agent, transfers, service } = await setup()
    const data = bytes(10)
    await expect(
      transfers.upload(
        target([P.ADMIN_ACCESS, P.DESKTOP_FILES_READ]),
        { root: ROOT, dir: '', name: 'a.bin', size: 10, sha256: sha(data) },
        body(data),
      ),
    ).rejects.toMatchObject({ statusCode: 403 })
    for (const path of ['../secreto.txt', 'a/../../b', 'C:/Windows/x', 'a\\b']) {
      await expect(
        service.dispatch({ ...target(), operation: 'files.download', args: { root: ROOT, path } }),
      ).rejects.toMatchObject({ statusCode: 400 })
    }
    expect(agent.sent).toHaveLength(0)
  })

  it('los datos de transferencia de otro equipo o de una tarea sin transferencia se ignoran', async () => {
    const { agent, transfers, service } = await setup()
    agent.files.set('a.bin', bytes(100))
    const { api } = memorySink()
    const running = transfers.download(target(), { root: ROOT, path: 'a.bin' }, api)
    await new Promise((r) => setTimeout(r, 5))
    const taskId = agent.sent[0]!.taskId
    await service.onAgentMessage('dev_ffffffffffffffffffffffff', {
      protocol_version: '1.2',
      message_id: randomUUID(),
      message_type: 'transfer.data',
      timestamp: new Date().toISOString(),
      device_id: 'dev_ffffffffffffffffffffffff',
      task_id: taskId,
      payload: { offset: 0, data: 'AAAA', eof: true },
    })
    const out = await running
    expect(out.execution.status).toBe('completed')
  })

  it('si el equipo se desconecta, la transferencia falla al momento y se cancela al reconectar', async () => {
    const { agent, transfers, service } = await setup()
    agent.files.set('a.bin', bytes(3 * CHUNK))
    // El agente deja de responder a las lecturas (conexión caída).
    const original = agent.sendTask.bind(agent)
    agent.sendTask = (deviceId, type, taskId, payload) =>
      type === 'transfer.read' ? true : original(deviceId, type, taskId, payload)
    const { sink, api } = memorySink()
    const started = Date.now()
    const running = transfers.download(target(), { root: ROOT, path: 'a.bin' }, api)
    await new Promise((r) => setTimeout(r, 20))
    await service.onDeviceDisconnected(DEVICE)
    await expect(running).rejects.toMatchObject({ code: 'DEVICE_DISCONNECTED' })
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(sink.aborted).toBe(true)

    agent.sendTask = original
    agent.sent = []
    await service.onDeviceReady(DEVICE)
    expect(agent.sent.map((s) => s.type)).toContain('task.cancel')
  })
})

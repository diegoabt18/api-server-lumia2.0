import websocket from '@fastify/websocket'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { AppContext } from '../app.context.js'
import { AppError } from '../common/errors/app.error.js'
import { hasPermission, PERMISSION_REGISTRY } from '../common/permissions/registry.js'
import { getClientIp } from '../common/utils/request.utils.js'
import { adminGuard } from '../modules/admin/middleware/admin-guard.js'
import {
  requireAuth,
  type AuthenticatedRequest,
} from '../modules/identity/middleware/auth.middleware.js'
import {
  deviceIdParamsSchema,
  registrationCompleteSchema,
  registrationStartSchema,
  renameDeviceSchema,
  toDeviceView,
} from '../modules/lumi/desktop-agent/domain/device.js'
import { MAX_MESSAGE_BYTES } from '../modules/lumi/desktop-agent/domain/protocol.js'
import type { DesktopDeviceStore } from '../modules/lumi/desktop-agent/infrastructure/desktop-device.repository.js'
import type { DesktopGateway } from '../modules/lumi/desktop-agent/services/desktop-gateway.js'
import type { DesktopEnrollmentService } from '../modules/lumi/desktop-agent/services/enrollment.service.js'
import type { DesktopExecutionService } from '../modules/lumi/desktop-agent/services/execution.service.js'
import type { DesktopApprovalStore } from '../modules/lumi/desktop-agent/infrastructure/desktop-approval.repository.js'
import type { DispatchOutcome } from '../modules/lumi/desktop-agent/services/execution.service.js'
import type { DesktopTransferService } from '../modules/lumi/desktop-agent/services/transfer.service.js'

export interface DesktopAgentRouteDeps {
  enrollment: DesktopEnrollmentService
  gateway: DesktopGateway
  devices: DesktopDeviceStore
  /** Ejecución de operaciones (fase 2). */
  execution?: DesktopExecutionService
  /** Aprobaciones recordadas de Lumi Chat (fase 4). */
  approvals?: DesktopApprovalStore
  /** Transferencias de archivos (fase 6). */
  transfers?: DesktopTransferService
  /** IP del cliente para los registros. Por defecto, la del proxy de confianza (getClientIp). */
  clientIp?: (request: FastifyRequest) => string | null
}

const dispatchBodySchema = z
  .object({
    operation: z.string().min(1).max(64),
    arguments: z.record(z.unknown()).default({}),
    timeout_ms: z.number().int().min(1_000).max(120_000).optional(),
  })
  .strict()

const executionIdParamsSchema = z.object({ id: z.string().regex(/^exe_[a-f0-9]{24}$/) })

const approvalIdParamsSchema = z.object({ id: z.string().uuid() })

const rootIdSchema = z.string().regex(/^root_[a-f0-9]{12}$/)
const fileListQuerySchema = z
  .object({ root: rootIdSchema, path: z.string().max(1024).default('') })
  .strict()
const fileDownloadQuerySchema = z
  .object({ root: rootIdSchema, path: z.string().min(1).max(1024) })
  .strict()
const fileUploadQuerySchema = z
  .object({
    root: rootIdSchema,
    dir: z.string().max(1024).default(''),
    name: z.string().min(1).max(200),
    size: z.coerce
      .number()
      .int()
      .min(0)
      .max(100 * 1024 * 1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()

/** Resultado de una operación de archivos, o el error con el código del agente. */
function fileResult(out: DispatchOutcome): unknown {
  if (out.execution.status === 'completed') return out.result
  const e = out.execution.error
  const status = out.execution.status === 'rejected' ? 409 : 502
  throw new AppError(
    status,
    e?.message ?? 'The file operation failed',
    e?.code ?? 'FILE_OPERATION_FAILED',
  )
}

/** `Content-Disposition` seguro para cualquier nombre (RFC 6266 + RFC 5987). */
function attachment(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
  return parsed.data
}

/**
 * Rutas que usa el propio agente: registro con prueba de posesión de la clave y el WebSocket.
 * No llevan sesión de usuario: la identidad del equipo se demuestra firmando desafíos.
 */
export async function registerDesktopAgentDeviceRoutes(
  api: FastifyInstance,
  deps: DesktopAgentRouteDeps,
) {
  const clientIp = deps.clientIp ?? getClientIp
  const registrationLimit = { config: { rateLimit: { max: 10, timeWindow: 60_000 } } }

  api.post('/desktop-agent/registrations/start', registrationLimit, async (request, reply) => {
    const result = await deps.enrollment.startRegistration(
      parse(registrationStartSchema, request.body),
    )
    return reply.code(201).send(result)
  })

  api.post('/desktop-agent/registrations/complete', registrationLimit, async (request, reply) => {
    const result = await deps.enrollment.completeRegistration(
      parse(registrationCompleteSchema, request.body),
    )
    request.log.info({ deviceId: result.device_id }, 'Desktop agent registered')
    return reply.code(201).send(result)
  })

  await api.register(async (scope) => {
    await scope.register(websocket, { options: { maxPayload: MAX_MESSAGE_BYTES } })
    scope.get(
      '/desktop-agent/ws',
      { websocket: true, config: { rateLimit: { max: 30, timeWindow: 60_000 } } },
      (socket, request) => {
        const handle = deps.gateway.accept(
          {
            send: (data) => socket.send(data),
            close: (code, reason) => socket.close(code, reason),
          },
          { ip: clientIp(request) },
        )
        socket.on('message', (data, isBinary) => {
          if (isBinary) {
            socket.close(4400, 'binary frames are not accepted')
            return
          }
          void handle.onMessage(data.toString())
        })
        socket.on('close', () => handle.onClose())
        socket.on('error', () => handle.onClose())
      },
    )
  })
}

type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<void>

/**
 * Guardas de las rutas de gestión. Dejan en la petición `auth.userId` y `permissionKeys`
 * (AuthenticatedRequest). En producción salen de la sesión del Server (desktopAdminGuards).
 */
export interface DesktopAdminGuards {
  /** admin.access + desktop.devices.read */
  read: Guard
  /** admin.access + desktop.devices.manage */
  manage: Guard
  /** Sesión + admin.access; el permiso de la operación lo comprueba el servicio. */
  panel: Guard
}

export function desktopAdminGuards(ctx: AppContext): DesktopAdminGuards {
  const auth = requireAuth(ctx.repos.sessions, ctx.services.authorization)
  return {
    read: adminGuard(
      ctx.repos.sessions,
      PERMISSION_REGISTRY.DESKTOP_DEVICES_READ,
      ctx.services.authorization,
    ),
    manage: adminGuard(
      ctx.repos.sessions,
      PERMISSION_REGISTRY.DESKTOP_DEVICES_MANAGE,
      ctx.services.authorization,
    ),
    async panel(request, reply) {
      await auth(request, reply)
      const keys = (request as AuthenticatedRequest).permissionKeys
      if (!hasPermission(keys, PERMISSION_REGISTRY.ADMIN_ACCESS))
        throw AppError.forbidden('Admin access required')
    },
  }
}

/**
 * Gestión de equipos desde Lumia Admin. Cada persona ve y gestiona solo los equipos que inscribió:
 * tener desktop.devices.manage no da acceso a los ordenadores de otros.
 */
export async function registerDesktopAgentAdminRoutes(
  api: FastifyInstance,
  guards: DesktopAdminGuards,
  deps: DesktopAgentRouteDeps,
) {
  const { read, manage, panel } = guards
  const userIdOf = (request: unknown): string => (request as AuthenticatedRequest).auth.userId

  api.get('/admin/desktop/devices', { preHandler: read }, async (request) => {
    const devices = await deps.devices.listByOwner(userIdOf(request))
    return { items: devices.map((d) => toDeviceView(d, deps.gateway.isOnline(d.id))) }
  })

  api.get('/admin/desktop/devices/:id', { preHandler: read }, async (request) => {
    const { id } = parse(deviceIdParamsSchema, request.params)
    const device = await deps.devices.findById(id)
    if (!device || device.ownerUserId !== userIdOf(request))
      throw AppError.notFound('Device not found')
    return toDeviceView(device, deps.gateway.isOnline(device.id))
  })

  api.post('/admin/desktop/enrollments', { preHandler: manage }, async (request, reply) => {
    return reply.code(201).send(await deps.enrollment.createEnrollment(userIdOf(request)))
  })

  api.patch('/admin/desktop/devices/:id', { preHandler: manage }, async (request) => {
    const { id } = parse(deviceIdParamsSchema, request.params)
    const { name } = parse(renameDeviceSchema, request.body)
    const device = await deps.devices.rename(id, userIdOf(request), name)
    if (!device) throw AppError.notFound('Device not found')
    return toDeviceView(device, deps.gateway.isOnline(device.id))
  })

  api.post('/admin/desktop/devices/:id/revoke', { preHandler: manage }, async (request) => {
    const { id } = parse(deviceIdParamsSchema, request.params)
    const device = await deps.devices.revoke(id, userIdOf(request), new Date())
    if (!device) throw AppError.notFound('Device not found')
    deps.gateway.disconnectRevoked(device.id)
    await deps.approvals?.removeForDevice(device.id)
    return toDeviceView(device, false)
  })

  const approvals = deps.approvals
  if (approvals) {
    /** Aprobaciones «no volver a preguntar» de Lumi Chat, propias. */
    api.get('/admin/desktop/approvals', { preHandler: read }, async (request) => {
      const items = await approvals.list(userIdOf(request))
      return {
        items: items.map((a) => ({
          id: a.id,
          deviceId: a.deviceId,
          kind: a.kind,
          target: a.target,
          createdAt: a.createdAt.toISOString(),
        })),
      }
    })

    // Retirar una aprobación solo restringe: vuelve a pedirse confirmación.
    api.delete('/admin/desktop/approvals/:id', { preHandler: read }, async (request) => {
      const { id } = parse(approvalIdParamsSchema, request.params)
      if (!(await approvals.remove(userIdOf(request), id)))
        throw AppError.notFound('Approval not found')
      return { removed: true }
    })
  }

  const execution = deps.execution
  if (!execution) return

  // El permiso concreto (desktop.browser.read o .control) depende de la operación: lo comprueba
  // el servicio. `panel` exige sesión y acceso al panel.
  const keysOf = (request: unknown) => (request as AuthenticatedRequest).permissionKeys ?? []

  /**
   * Ordena una operación y espera su resultado verificado (hasta el tiempo límite). El resultado
   * solo viaja en esta respuesta; el registro guarda únicamente metadatos.
   */
  api.post(
    '/admin/desktop/devices/:id/executions',
    { preHandler: panel, config: { rateLimit: { max: 30, timeWindow: 60_000 } } },
    async (request) => {
      const { id } = parse(deviceIdParamsSchema, request.params)
      const body = parse(dispatchBodySchema, request.body)
      return execution.dispatch({
        userId: userIdOf(request),
        permissionKeys: keysOf(request),
        deviceId: id,
        operation: body.operation,
        args: body.arguments,
        timeoutMs: body.timeout_ms,
      })
    },
  )

  api.get('/admin/desktop/devices/:id/executions', { preHandler: read }, async (request) => {
    const { id } = parse(deviceIdParamsSchema, request.params)
    return { items: await execution.listForDevice(id, userIdOf(request)) }
  })

  api.post('/admin/desktop/executions/:id/cancel', { preHandler: panel }, async (request) => {
    const { id } = parse(executionIdParamsSchema, request.params)
    return execution.cancel(id, userIdOf(request), keysOf(request))
  })

  const transfers = deps.transfers
  if (!transfers) return
  const target = (request: FastifyRequest, deviceId: string) => ({
    userId: userIdOf(request),
    permissionKeys: keysOf(request),
    deviceId,
  })

  /** Carpetas que el usuario autorizó en el equipo (id y nombre; nunca la ruta completa). */
  api.get('/admin/desktop/devices/:id/files/roots', { preHandler: panel }, async (request) => {
    const { id } = parse(deviceIdParamsSchema, request.params)
    return fileResult(
      await execution.dispatch({ ...target(request, id), operation: 'files.roots', args: {} }),
    )
  })

  api.get(
    '/admin/desktop/devices/:id/files',
    { preHandler: panel, config: { rateLimit: { max: 60, timeWindow: 60_000 } } },
    async (request) => {
      const { id } = parse(deviceIdParamsSchema, request.params)
      const query = parse(fileListQuerySchema, request.query)
      return fileResult(
        await execution.dispatch({
          ...target(request, id),
          operation: 'files.list',
          args: { root: query.root, path: query.path },
        }),
      )
    },
  )

  /**
   * Descarga: se responde en streaming con lo que llega del equipo. Si algo falla antes del primer
   * byte, es un error JSON normal; después, la conexión se corta (el navegador ve la descarga
   * incompleta) y la tarea se cancela.
   */
  api.get(
    '/admin/desktop/devices/:id/files/download',
    { preHandler: panel, config: { rateLimit: { max: 20, timeWindow: 60_000 } } },
    async (request, reply) => {
      const { id } = parse(deviceIdParamsSchema, request.params)
      const query = parse(fileDownloadQuerySchema, request.query)
      let started = false
      try {
        await transfers.download(target(request, id), query, {
          start(info) {
            started = true
            reply.hijack()
            reply.raw.writeHead(200, {
              'Content-Type': 'application/octet-stream',
              'Content-Length': String(info.size),
              'Content-Disposition': attachment(info.name),
              'X-Content-SHA256': info.sha256,
              'X-Content-Type-Options': 'nosniff',
              'Cache-Control': 'no-store',
            })
          },
          write: (chunk) =>
            new Promise<void>((resolve, reject) => {
              if (reply.raw.destroyed) return reject(new Error('client disconnected'))
              reply.raw.write(chunk, (err) => (err ? reject(err) : resolve()))
            }),
          end: () => reply.raw.end(),
          abort: () => reply.raw.destroy(),
        })
      } catch (error) {
        if (!started) throw error
        request.log.warn({ err: error, deviceId: id }, 'Desktop file download interrupted')
      }
    },
  )

  /**
   * Subida: el cuerpo es el archivo (`application/octet-stream`) y se retransmite por bloques
   * sin guardarlo. Tamaño y SHA-256 van en la consulta y en el grant firmado.
   */
  await api.register(async (scope) => {
    scope.addContentTypeParser('application/octet-stream', (_request, payload, done) => {
      done(null, payload)
    })
    scope.post(
      '/admin/desktop/devices/:id/files/upload',
      { preHandler: panel, config: { rateLimit: { max: 10, timeWindow: 60_000 } } },
      async (request) => {
        const { id } = parse(deviceIdParamsSchema, request.params)
        const query = parse(fileUploadQuerySchema, request.query)
        const declared = Number(request.headers['content-length'])
        if (Number.isFinite(declared) && declared !== query.size) {
          throw new AppError(
            400,
            'Content-Length does not match the declared size',
            'SIZE_MISMATCH',
          )
        }
        const body = request.body as AsyncIterable<Buffer> | undefined
        if (
          !body ||
          typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !== 'function'
        ) {
          throw AppError.badRequest('The body must be the file (application/octet-stream)')
        }
        const out = await transfers.upload(target(request, id), query, body)
        return { execution: out.execution, file: out.result }
      },
    )
  })
}

export async function registerDesktopAgentRoutes(api: FastifyInstance, ctx: AppContext) {
  const desktop = ctx.services.desktopAgent
  if (!desktop) return
  const deps: DesktopAgentRouteDeps = {
    enrollment: desktop.enrollment,
    gateway: desktop.gateway,
    devices: desktop.devices,
    execution: desktop.execution,
    approvals: desktop.approvals,
    transfers: desktop.transfers,
  }
  await registerDesktopAgentDeviceRoutes(api, deps)
  await registerDesktopAgentAdminRoutes(api, desktopAdminGuards(ctx), deps)
}

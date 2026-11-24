/**
 * Vista previa de Lumia Admin con Lumia Desktop Agent, SOLO PARA DESARROLLO (fase 5). Todo en
 * memoria: sin MongoDB, sin Redis, sin asistente y sin tocar datos reales.
 *
 *   npx tsx scripts/desktop-admin-preview-server.ts [--port 3941]
 *
 * Sirve lo mínimo que Lumia Admin necesita para probar en el navegador la sección Dispositivos y
 * las confirmaciones del chat con un agente real:
 *  - una sesión ficticia (`/api/auth/*`): cualquier correo/contraseña entra como `preview-user`
 *    con admin.access, lumi.use y los ocho permisos desktop.*;
 *  - las rutas reales de gestión (registerDesktopAgentAdminRoutes), incluidas las de archivos
 *    (fase 6), con guardas de esa sesión;
 *  - las rutas reales del agente (registro y WebSocket);
 *  - un chat mínimo (`/api/admin/lumi/chat/stream`) que solo entiende las reglas de las
 *    herramientas `device.*` y las respuestas «sí»/«no» (handleDesktopReply), con los mismos
 *    eventos SSE que el Server: tool, confirmation, token, done.
 *
 * Imprime `ENROLLMENT_CODE=<código>` para el agente headless. Nunca usar fuera de local: la sesión
 * no tiene credenciales reales.
 */
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import { AppError } from '../src/common/errors/app.error.js'
import { PERMISSION_REGISTRY as P, type PermissionId } from '../src/common/permissions/registry.js'
import { MemoryPendingActions } from '../src/modules/lumi/actions/pending-action.js'
import { assembleDesktopAgentServices } from '../src/modules/lumi/desktop-agent/index.js'
import { MemoryDesktopApprovalStore } from '../src/modules/lumi/desktop-agent/infrastructure/desktop-approval.repository.js'
import {
  MemoryDesktopDeviceStore,
  MemoryDesktopEnrollmentStore,
  MemoryPendingRegistrationStore,
} from '../src/modules/lumi/desktop-agent/infrastructure/desktop-device.repository.js'
import { MemoryDesktopExecutionStore } from '../src/modules/lumi/desktop-agent/infrastructure/desktop-execution.repository.js'
import { GrantSigner } from '../src/modules/lumi/desktop-agent/infrastructure/grant-signer.js'
import { DesktopEnrollmentService } from '../src/modules/lumi/desktop-agent/services/enrollment.service.js'
import { lumiChatBodySchema } from '../src/modules/lumi/schemas/lumi.schema.js'
import { matchTool, runTool } from '../src/modules/lumi/tools/catalog.js'
import { handleDesktopReply } from '../src/modules/lumi/tools/desktop.tools.js'
import type { LumiToolContext } from '../src/modules/lumi/tools/tool.types.js'
import {
  registerDesktopAgentAdminRoutes,
  registerDesktopAgentDeviceRoutes,
  type DesktopAdminGuards,
} from '../src/routes/lumi-desktop-agent.routes.js'

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const port = Number(arg('port') ?? 3941)
const USER = {
  id: 'preview-user',
  email: 'preview@lumia.local',
  name: 'Vista previa',
  provider: 'local' as const,
}
const KEYS: PermissionId[] = [
  P.ADMIN_ACCESS,
  P.LUMI_USE,
  P.DESKTOP_DEVICES_READ,
  P.DESKTOP_DEVICES_MANAGE,
  P.DESKTOP_BROWSER_READ,
  P.DESKTOP_BROWSER_CONTROL,
  P.DESKTOP_APPS_READ,
  P.DESKTOP_APPS_CONTROL,
  P.DESKTOP_FILES_READ,
  P.DESKTOP_FILES_WRITE,
]
const ACCESS = `preview-access-${randomUUID()}`
const REFRESH = `preview-refresh-${randomUUID()}`

const log = {
  info: (obj: object, msg: string) => console.log(`[server] ${msg} ${JSON.stringify(obj)}`),
  warn: (obj: object, msg: string) => console.log(`[server] WARN ${msg} ${JSON.stringify(obj)}`),
}

const devices = new MemoryDesktopDeviceStore()
const executions = new MemoryDesktopExecutionStore()
const approvals = new MemoryDesktopApprovalStore()
const enrollment = new DesktopEnrollmentService({
  devices,
  enrollments: new MemoryDesktopEnrollmentStore(),
  registrations: new MemoryPendingRegistrationStore(),
})
const services = assembleDesktopAgentServices({
  devices,
  executions,
  enrollment,
  signer: GrantSigner.fromEnv(undefined, 'development', log),
  approvals,
  pending: new MemoryPendingActions(),
  log,
})

function cookie(request: FastifyRequest, name: string): string | undefined {
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return rest.join('=')
  }
  return undefined
}

/** La sesión ficticia: el BFF manda la cookie de acceso que emitió este servidor. */
async function session(request: FastifyRequest, _reply: FastifyReply) {
  if (cookie(request, 'lumia_access') !== ACCESS) throw AppError.unauthorized()
  const req = request as FastifyRequest & {
    auth: { userId: string }
    permissionKeys: PermissionId[]
  }
  req.auth = { userId: USER.id }
  req.permissionKeys = KEYS
}
const guards: DesktopAdminGuards = { read: session, manage: session, panel: session }

const issueCookies = (reply: FastifyReply) =>
  reply.header('set-cookie', [
    `lumia_access=${ACCESS}; Path=/; Max-Age=3600; HttpOnly; SameSite=Strict`,
    `lumia_refresh=${REFRESH}; Path=/; Max-Age=86400; HttpOnly; SameSite=Strict`,
  ])

const app = Fastify()
// Misma forma que el Server real (src/routes/index.ts).
app.setErrorHandler((error, request, reply) => {
  const appError = error instanceof AppError ? error : null
  if (!appError) console.error(error)
  void reply.code(appError?.statusCode ?? 500).send({
    error: true,
    message: appError?.message ?? 'Internal server error',
    code: appError?.code ?? 'INTERNAL_ERROR',
    details: appError?.details,
    requestId: request.id,
  })
})

await app.register(
  async (api) => {
    api.post('/auth/login', async (_request, reply) => {
      issueCookies(reply)
      return { user: USER }
    })
    api.post('/auth/refresh', async (request, reply) => {
      if (cookie(request, 'lumia_refresh') !== REFRESH) throw AppError.unauthorized()
      issueCookies(reply)
      return { ok: true }
    })
    api.post('/auth/logout', async () => ({ ok: true }))
    api.get('/auth/me', { preHandler: session }, async () => ({ user: USER }))
    api.get('/auth/permissions', { preHandler: session }, async () => ({ permissions: KEYS }))

    await registerDesktopAgentDeviceRoutes(api, {
      enrollment,
      gateway: services.gateway,
      devices,
      clientIp: (r) => r.ip,
    })
    await registerDesktopAgentAdminRoutes(api, guards, {
      enrollment,
      gateway: services.gateway,
      devices,
      execution: services.execution,
      approvals,
      transfers: services.transfers,
    })

    api.post('/admin/lumi/chat/stream', { preHandler: session }, async (request, reply) => {
      const parsed = lumiChatBodySchema.safeParse(request.body)
      if (!parsed.success) throw AppError.badRequest('Invalid input', parsed.error.flatten())
      const { message, confirmationId } = parsed.data
      const ctx = {
        userId: USER.id,
        permissionKeys: KEYS,
        now: new Date(),
        timezone: 'America/Bogota',
        deps: { desktop: services.lumiPort },
      } as unknown as LumiToolContext
      const events: Array<[string, unknown]> = []
      const answer = await handleDesktopReply(ctx, message, confirmationId)
      let text = answer
      if (text === null) {
        const match = matchTool(message, KEYS, { now: ctx.now, timezone: ctx.timezone })
        if (match && match.tool.name.startsWith('device.')) {
          const result = await runTool(match, ctx)
          events.push([
            'tool',
            {
              name: match.tool.name,
              label: match.tool.label,
              rows: result.rows,
              denied: match.denied,
            },
          ])
          if (result.confirmation) events.push(['confirmation', result.confirmation])
          text = result.text
        } else {
          text =
            'Vista previa: aquí solo entiendo órdenes del equipo («abre https://…», «pulsa X en la página», «¿está conectado mi computador?»).'
        }
      }
      console.log(
        `[chat] «${message}»${confirmationId ? ` (tarjeta ${confirmationId})` : ''} → ${text.split('\n')[0]}`,
      )
      events.push(
        ['token', { text }],
        ['done', { conversationId: parsed.data.conversationId ?? randomUUID() }],
      )
      reply.hijack()
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
      })
      for (const [event, data] of events)
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      reply.raw.end()
    })
  },
  { prefix: '/api' },
)

const FORM = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Formulario de prueba</title></head>
<body><h1>Prueba del agente</h1><label>Nombre <input id="nombre"></label>
<button onclick="location.href='/demo/gracias?n='+encodeURIComponent(document.getElementById('nombre').value)">Enviar</button></body></html>`
app.get('/demo/form', async (_req, reply) => reply.type('text/html; charset=utf-8').send(FORM))
app.get('/demo/gracias', async (_req, reply) =>
  reply
    .type('text/html; charset=utf-8')
    .send('<!doctype html><title>Gracias</title><p>Recibido</p>'),
)

await app.listen({ host: '127.0.0.1', port })
const { code } = await enrollment.createEnrollment(USER.id)
console.log(`LISTENING=http://127.0.0.1:${port}`)
console.log(`ENROLLMENT_CODE=${code}`)

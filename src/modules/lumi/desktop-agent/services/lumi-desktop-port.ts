import { isAppError } from '../../../../common/errors/app.error.js'
import type { PendingActionStore } from '../../actions/pending-action.js'
import { PENDING_ACTION_TTL_MS } from '../../actions/pending-action.js'
import type { LumiDesktopPort } from '../../tools/tool.types.js'
import type { DesktopDeviceStore } from '../infrastructure/desktop-device.repository.js'
import type { DesktopApprovalStore } from '../infrastructure/desktop-approval.repository.js'
import type { DesktopExecutionService } from './execution.service.js'

/**
 * Puerto de Lumi Chat hacia los equipos: lista los equipos propios, ordena operaciones con los
 * permisos de quien escribe (el servicio de ejecuciones autoriza y firma) y guarda aprobaciones y
 * acciones pendientes de confirmar. El texto de la respuesta lo construyen las herramientas.
 */
export function createLumiDesktopPort(deps: {
  devices: DesktopDeviceStore
  isOnline: (deviceId: string) => boolean
  execution: DesktopExecutionService
  approvals: DesktopApprovalStore
  pending: PendingActionStore
  now?: () => Date
}): LumiDesktopPort {
  const now = deps.now ?? (() => new Date())
  return {
    async devices(userId) {
      const devices = await deps.devices.listByOwner(userId)
      return devices
        .filter((d) => d.status === 'active')
        .map((d) => ({
          id: d.id,
          name: d.name,
          online: deps.isOnline(d.id),
          paused: d.execution === 'paused',
          operations: d.capabilities?.operations ?? [],
        }))
    },

    async execute({ userId, permissionKeys, deviceId, operation, args, timeoutMs, onStarted, onStage }) {
      try {
        const out = await deps.execution.dispatch({
          userId,
          permissionKeys,
          deviceId,
          operation,
          args,
          timeoutMs,
          onStarted,
          onStage,
        })
        return {
          status: out.execution.status,
          result:
            out.result && typeof out.result === 'object'
              ? (out.result as Record<string, unknown>)
              : null,
          error: out.execution.error
            ? { code: out.execution.error.code, message: out.execution.error.message }
            : null,
        }
      } catch (err) {
        // Rechazos del Server (permiso, equipo desconectado, argumentos): no se ejecutó nada.
        if (isAppError(err)) {
          return {
            status: 'refused',
            result: null,
            error: { code: err.code ?? 'ERROR', message: err.message },
          }
        }
        throw err
      }
    },

    isApproved: (userId, approval) => deps.approvals.has(userId, approval),

    approve: (userId, approval) => deps.approvals.add(userId, approval, now()),

    async savePending(userId, payload, summary) {
      const createdAt = now()
      const saved = await deps.pending.put({
        userId,
        kind: 'desktop_action',
        payload,
        summary,
        createdAt,
        expiresAt: new Date(createdAt.getTime() + PENDING_ACTION_TTL_MS),
      })
      return { id: saved.id, expiresAt: saved.expiresAt }
    },

    async takePending(userId, id) {
      const action = await deps.pending.take(userId, 'desktop_action', now(), id)
      return action?.payload ?? null
    },
  }
}

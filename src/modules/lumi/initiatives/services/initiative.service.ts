import { AppError } from '../../../../common/errors/app.error.js'
import type { InitiativeStore } from '../domain/initiative.store.js'
import type { PermissionId } from '../../../../common/permissions/registry.js'
import {
  allowedInitiativeKinds,
  canTransition,
  type InitiativeLevel,
  type InitiativeState,
  type LumiInitiative,
} from '../domain/initiative.types.js'

/** Casos de uso de las iniciativas que la persona ve y gestiona desde lumia-admin. */
export class LumiInitiativeService {
  constructor(
    private readonly store: InitiativeStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Solo los tipos que el usuario puede ver con sus permisos actuales. */
  list(
    userId: string,
    permissionKeys: readonly PermissionId[],
    options: { state?: InitiativeState; limit: number },
  ): Promise<LumiInitiative[]> {
    return this.store.listForUser(userId, { ...options, kinds: allowedInitiativeKinds(permissionKeys) })
  }

  async changeState(
    userId: string,
    permissionKeys: readonly PermissionId[],
    id: string,
    to: InitiativeState,
  ): Promise<LumiInitiative> {
    const item = await this.store.findForUser(id, userId)
    // Una iniciativa de un tipo que ya no puede ver se trata como inexistente.
    if (!item || !allowedInitiativeKinds(permissionKeys).includes(item.kind)) {
      throw AppError.notFound('Iniciativa no encontrada')
    }
    if (item.state === to) return item
    if (!canTransition(item.state, to)) {
      throw AppError.conflict(`No se puede pasar de «${item.state}» a «${to}».`)
    }
    const now = this.now()
    await this.store.update(id, {
      state: to,
      stateChangedAt: now,
      ...(to === 'completada' ? { resolvedAt: now } : {}),
    })
    const updated = await this.store.findForUser(id, userId)
    if (!updated) throw AppError.notFound('Iniciativa no encontrada')
    return updated
  }

  getLevel(userId: string): Promise<InitiativeLevel> {
    return this.store.getLevel(userId)
  }

  setLevel(userId: string, level: InitiativeLevel): Promise<void> {
    return this.store.setLevel(userId, level)
  }
}

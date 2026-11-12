import { ObjectId } from 'mongodb'
import { AppError } from '../../../common/errors/app.error.js'
import { buildPaginationMeta, resolvePagingQuery } from '../../../common/utils/pagination.js'
import type { InventoryRepository } from '../../catalog/infrastructure/inventory.repository.js'
import type { DepositPolicy } from '../../catalog/domain/deposit-policy.js'
import type { ProductionAuditRepository } from '../../production/infrastructure/production-audit.repository.js'

/** Política tal como llega del cliente: la autorización no trae identidad (la fija el servidor). */
export type DepositPolicyInput = Omit<DepositPolicy, 'authorization'> & {
  authorization?: { reason: string; authorizedBy?: string } | null
}

export interface InventoryUpsertInput {
  quantity?: number
  reserved?: number
  warehouse?: string
  is_per_order?: boolean
  deposit_policy?: DepositPolicyInput | null
  /** Versión de la política que vio quien edita (control optimista). Obligatoria al cambiar la política. */
  expected_version?: number
}

/** Estado de una política para la auditoría: solo los campos que importan, sin marcas internas. */
function policySnapshot(policy: DepositPolicy | null | undefined) {
  if (!policy) return null
  return {
    type: policy.type,
    value: policy.value,
    ...(policy.authorization
      ? {
          authorization: {
            authorizedBy: policy.authorization.authorizedBy,
            reason: policy.authorization.reason,
          },
        }
      : {}),
  }
}

export class AdminInventoryService {
  constructor(
    private readonly inventory: InventoryRepository,
    private readonly audit: ProductionAuditRepository,
  ) {}

  async list(query: Record<string, unknown>) {
    const { page, limit, skip, search } = resolvePagingQuery(query, {
      defaultLimit: 50,
      maxLimit: 200,
    })
    const { items, total } = await this.inventory.listAdmin(skip, limit, search || undefined)
    return { items, pagination: buildPaginationMeta(total, page, limit) }
  }

  /** Historial de cambios de la política de anticipo de un SKU (más reciente primero). */
  async depositPolicyHistory(sku: string, limit = 20) {
    const { items } = await this.audit.list({
      entityType: 'inventory_sku',
      entityId: sku,
      eventType: undefined,
      limit: Math.min(Math.max(limit, 1), 100),
      offset: 0,
    })
    // La política vigente la lee Server: la interfaz nunca debe reconstruirla desde datos de listado.
    const state = await this.inventory.getDepositPolicyState(sku)
    return {
      sku,
      current: policySnapshot(state.policy),
      version: state.version,
      items: items
        .filter(
          (e) =>
            e.eventType === 'deposit_policy_changed' || e.eventType === 'deposit_policy_removed',
        )
        .map((e) => ({
          id: e.id,
          eventType: e.eventType,
          description: e.description,
          previousValue: e.previousValue ?? null,
          newValue: e.newValue ?? null,
          performedBy: e.performedBy,
          createdAt: e.createdAt,
        })),
    }
  }

  /**
   * Actualiza inventario. Si cambia la política de anticipo:
   *  - exige la versión que vio quien edita (control optimista; si cambió, 409);
   *  - el cambio es atómico respecto a su versión;
   *  - queda auditado (quién, cuándo, anterior y nueva). Si la auditoría falla, se restaura la anterior.
   */
  async upsertBySku(sku: string, data: InventoryUpsertInput, actorId: string) {
    if (data.deposit_policy === undefined) {
      await this.inventory.upsertBySku({ sku, ...data, deposit_policy: undefined })
      return { ok: true }
    }
    if (data.expected_version === undefined) {
      throw AppError.badRequest(
        'Falta la versión de la política (expected_version). Recarga y vuelve a intentar.',
      )
    }
    const expected = data.expected_version

    const state = await this.inventory.getDepositPolicyState(sku)
    const previous = state.policy
    const next: DepositPolicy | null = data.deposit_policy
      ? {
          type: data.deposit_policy.type,
          value: data.deposit_policy.value,
          // Identidad desde la sesión: cualquier `authorizedBy` del cliente se descarta aquí.
          // La clave se omite (no `undefined`): Mongo guardaría `undefined` como `null`.
          ...(data.deposit_policy.authorization
            ? {
                authorization: {
                  authorizedBy: actorId,
                  reason: data.deposit_policy.authorization.reason,
                  authorizedAt: new Date(),
                },
              }
            : {}),
        }
      : null

    const swapped = await this.inventory.compareAndSetDepositPolicy(sku, expected, next)
    if (!swapped) {
      throw AppError.conflict(
        'La política cambió mientras la editabas. Recarga para ver la versión actual.',
      )
    }

    // Resto de campos de inventario (sin tocar la política ya guardada).
    await this.inventory.upsertBySku({
      sku,
      quantity: data.quantity,
      reserved: data.reserved,
      warehouse: data.warehouse,
      is_per_order: data.is_per_order,
      deposit_policy: undefined,
    })

    try {
      await this.audit.insert({
        event_type: next ? 'deposit_policy_changed' : 'deposit_policy_removed',
        entity_type: 'inventory_sku',
        entity_id: sku,
        description: next
          ? `Política de anticipo ${previous ? 'modificada' : 'creada'} para ${sku}`
          : `Política de anticipo eliminada para ${sku}`,
        previous_value: policySnapshot(previous),
        new_value: policySnapshot(next),
        performed_by: ObjectId.isValid(actorId) ? new ObjectId(actorId) : actorId,
        created_at: new Date(),
      })
    } catch (error) {
      // Compensación: sin registro de auditoría no puede quedar un cambio de política.
      await this.inventory.compareAndSetDepositPolicy(sku, expected + 1, previous)
      throw error
    }
    return { ok: true }
  }
}

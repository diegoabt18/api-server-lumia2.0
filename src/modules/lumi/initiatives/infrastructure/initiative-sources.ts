import type { ProductRepository } from '../../../catalog/infrastructure/product.repository.js'
import type { OrderRepository } from '../../../sales/infrastructure/order.repository.js'
import type { AutomationStore } from '../../automation/domain/automation.store.js'
import {
  DAY_MS,
  detectFailedRoutines,
  detectStaleOrders,
  detectStock,
  type InitiativeCandidate,
} from '../domain/initiative.detectors.js'
import type { InitiativeKind } from '../domain/initiative.types.js'
import type { CandidateBatch, InitiativeSources } from '../services/initiative-engine.js'

/** Umbrales de las reglas. Cambiarlos aquí afecta a todas las iniciativas nuevas. */
export const INITIATIVE_THRESHOLDS = {
  lowStockUnits: 3,
  staleOrderDays: 3,
  failedRoutineWindowDays: 7,
  /** Límite de filas por lectura: el motor nunca carga catálogos completos. */
  scanLimit: 200,
  executionsPerUser: 100,
} as const

export type InitiativeThresholds = { [K in keyof typeof INITIATIVE_THRESHOLDS]: number }

/** Lee las señales del catálogo, los pedidos y las rutinas, y las convierte en candidatos. */
export class RepositoryInitiativeSources implements InitiativeSources {
  constructor(
    private readonly products: ProductRepository,
    private readonly orders: OrderRepository,
    private readonly automation: AutomationStore,
    private readonly thresholds: InitiativeThresholds = INITIATIVE_THRESHOLDS,
  ) {}

  /**
   * Una lectura que devuelve tantas filas como el límite puede haber dejado fuera otras: ese tipo se
   * marca como truncado y el motor no completa iniciativas de él en esta pasada.
   */
  async globalCandidates(now: Date): Promise<CandidateBatch> {
    const t = this.thresholds
    const [stock, paid] = await Promise.all([
      this.products.findStockAlerts(t.lowStockUnits, t.scanLimit),
      this.orders.findPaidBefore(new Date(now.getTime() - t.staleOrderDays * DAY_MS), t.scanLimit),
    ])
    const truncated: InitiativeKind[] = []
    if (stock.length >= t.scanLimit) truncated.push('stock')
    if (paid.length >= t.scanLimit) truncated.push('order_attention')
    const candidates: InitiativeCandidate[] = [
      ...detectStock(stock, t.lowStockUnits),
      ...detectStaleOrders(paid, now, t.staleOrderDays),
    ]
    return { candidates, truncated }
  }

  async userCandidates(userId: string, now: Date): Promise<CandidateBatch> {
    const executions = await this.automation.listExecutionsForUser(
      userId,
      undefined,
      this.thresholds.executionsPerUser,
    )
    const candidates = detectFailedRoutines(
      executions.map((e) => ({ taskId: e.taskId, status: e.status, finishedAt: e.finishedAt })),
      now,
      this.thresholds.failedRoutineWindowDays,
    )
    return {
      candidates,
      truncated: executions.length >= this.thresholds.executionsPerUser ? ['routine_failed'] : [],
    }
  }
}

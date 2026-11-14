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
import type { InitiativeSources } from '../services/initiative-engine.js'

/** Umbrales de las reglas. Cambiarlos aquí afecta a todas las iniciativas nuevas. */
export const INITIATIVE_THRESHOLDS = {
  lowStockUnits: 3,
  staleOrderDays: 3,
  failedRoutineWindowDays: 7,
  /** Límite de filas por lectura: el motor nunca carga catálogos completos. */
  scanLimit: 200,
  executionsPerUser: 100,
} as const

/** Lee las señales del catálogo, los pedidos y las rutinas, y las convierte en candidatos. */
export class RepositoryInitiativeSources implements InitiativeSources {
  constructor(
    private readonly products: ProductRepository,
    private readonly orders: OrderRepository,
    private readonly automation: AutomationStore,
    private readonly thresholds = INITIATIVE_THRESHOLDS,
  ) {}

  async globalCandidates(now: Date): Promise<InitiativeCandidate[]> {
    const t = this.thresholds
    const [stock, paid] = await Promise.all([
      this.products.findStockAlerts(t.lowStockUnits, t.scanLimit),
      this.orders.findPaidBefore(new Date(now.getTime() - t.staleOrderDays * DAY_MS), t.scanLimit),
    ])
    return [
      ...detectStock(stock, t.lowStockUnits),
      ...detectStaleOrders(paid, now, t.staleOrderDays),
    ]
  }

  async userCandidates(userId: string, now: Date): Promise<InitiativeCandidate[]> {
    const executions = await this.automation.listExecutionsForUser(
      userId,
      undefined,
      this.thresholds.executionsPerUser,
    )
    return detectFailedRoutines(
      executions.map((e) => ({ taskId: e.taskId, status: e.status, finishedAt: e.finishedAt })),
      now,
      this.thresholds.failedRoutineWindowDays,
    )
  }
}

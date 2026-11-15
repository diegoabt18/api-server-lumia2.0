import type { InitiativeCandidate } from '../domain/initiative.detectors.js'
import type { InitiativeStore } from '../domain/initiative.store.js'
import { shouldNotify } from '../domain/initiative.rules.js'
import type { PermissionId } from '../../../../common/permissions/registry.js'
import { PERMISSION_REGISTRY, hasPermission } from '../../../../common/permissions/registry.js'
import {
  allowedInitiativeKinds,
  INITIATIVE_KINDS,
  OPEN_INITIATIVE_STATES,
  type InitiativeKind,
} from '../domain/initiative.types.js'

/**
 * Resultado de una lectura de señales. `truncated` lista los tipos cuya lectura alcanzó el límite de
 * filas: de esos tipos no se sabe qué quedó fuera, así que no se puede dar nada por resuelto.
 */
export interface CandidateBatch {
  candidates: InitiativeCandidate[]
  truncated: InitiativeKind[]
}

/** Fuentes de señales. El adaptador de infraestructura lee catálogo, pedidos y automatizaciones. */
export interface InitiativeSources {
  /** Señales comunes a todos los usuarios (stock, pedidos). Una lectura por ejecución. */
  globalCandidates(now: Date): Promise<CandidateBatch>
  /** Señales propias de cada usuario (rutinas fallidas). */
  userCandidates(userId: string, now: Date): Promise<CandidateBatch>
}

/** Claves de permiso efectivas de un usuario (el servicio de autorización, con su caché). */
export type PermissionLookup = (userId: string) => Promise<readonly PermissionId[]>

/** Mismo contrato que NotificationSink del motor de automatización. */
export interface InitiativeNotifier {
  notify(input: { userId: string; title: string; message: string; data: Record<string, string> }): Promise<void>
}

export interface InitiativeRunSummary {
  users: number
  created: number
  reopened: number
  completed: number
  notified: number
}

const MAX_OPEN_PER_USER = 500

export function dedupKeyOf(candidate: Pick<InitiativeCandidate, 'kind' | 'subjectKey'>): string {
  return `${candidate.kind}:${candidate.subjectKey}`
}

/** Un mismo sujeto puede aparecer varias veces en una ejecución: se conserva la prioridad más alta. */
function uniqueCandidates(candidates: readonly InitiativeCandidate[]): InitiativeCandidate[] {
  const byKey = new Map<string, InitiativeCandidate>()
  for (const candidate of candidates) {
    const key = dedupKeyOf(candidate)
    const current = byKey.get(key)
    if (!current || candidate.priority > current.priority) byKey.set(key, candidate)
  }
  return [...byKey.values()]
}

/**
 * Concilia las señales detectadas con las iniciativas guardadas de cada usuario:
 *  - una señal nueva crea una iniciativa "nueva" (y notifica según el nivel);
 *  - una señal que sigue activa actualiza título, detalle y prioridad, sin notificar de nuevo;
 *  - una iniciativa resuelta pasa a "completada"; si la condición vuelve, se reabre como nueva;
 *  - las rechazadas y descartadas no se recrean: la decisión de la persona es definitiva.
 * Si una fuente falla, la ejecución se interrumpe antes de conciliar: nunca se completan iniciativas
 * por una lectura incompleta.
 */
export class InitiativeEngine {
  constructor(
    private readonly store: InitiativeStore,
    private readonly sources: InitiativeSources,
    private readonly notifier: InitiativeNotifier,
    private readonly now: () => Date = () => new Date(),
    private readonly onError: (err: unknown, userId?: string) => void = () => {},
    private readonly permissionsOf: PermissionLookup | null = null,
  ) {}

  /**
   * Tipos que el usuario puede ver. Sin `lumi.use` no recibe ninguno: perder el acceso a Lumi detiene
   * sus iniciativas aunque conserve la rutina. Sin consulta de permisos configurada, todos.
   */
  private async allowedKinds(userId: string): Promise<InitiativeKind[]> {
    if (!this.permissionsOf) return [...INITIATIVE_KINDS]
    const keys = await this.permissionsOf(userId)
    if (!hasPermission([...keys], PERMISSION_REGISTRY.LUMI_USE)) return []
    return allowedInitiativeKinds(keys)
  }

  async runOnce(): Promise<InitiativeRunSummary> {
    const now = this.now()
    const global = await this.sources.globalCandidates(now)
    const users = await this.store.listUsersWithReviewRoutine()
    const summary: InitiativeRunSummary = { users: users.length, created: 0, reopened: 0, completed: 0, notified: 0 }

    for (const userId of users) {
      try {
        const allowed = new Set(await this.allowedKinds(userId))
        if (allowed.size === 0) continue
        const personal = await this.sources.userCandidates(userId, now)
        const candidates = [...global.candidates, ...personal.candidates].filter((c) => allowed.has(c.kind))
        const result = await this.reconcileUser(userId, candidates, now, {
          allowed,
          truncated: new Set([...global.truncated, ...personal.truncated]),
        })
        summary.created += result.created
        summary.reopened += result.reopened
        summary.completed += result.completed
        summary.notified += result.notified
      } catch (err) {
        // Un usuario con error no detiene a los demás.
        this.onError(err, userId)
      }
    }
    return summary
  }

  async reconcileUser(
    userId: string,
    candidates: readonly InitiativeCandidate[],
    now: Date,
    scope: { allowed?: ReadonlySet<InitiativeKind>; truncated?: ReadonlySet<InitiativeKind> } = {},
  ): Promise<Omit<InitiativeRunSummary, 'users'>> {
    const result = { created: 0, reopened: 0, completed: 0, notified: 0 }
    const level = await this.store.getLevel(userId)
    const existing = await this.store.listForUser(userId, { limit: MAX_OPEN_PER_USER })
    const byKey = new Map(existing.map((item) => [item.dedupKey, item] as const))
    const seen = new Set<string>()

    for (const candidate of uniqueCandidates(candidates)) {
      const key = dedupKeyOf(candidate)
      seen.add(key)
      const current = byKey.get(key)

      let isNew = false
      let escalated = false
      let openCount = 1
      let id: string
      if (!current) {
        const created = await this.store.insert({
          userId,
          kind: candidate.kind,
          subjectKey: candidate.subjectKey,
          dedupKey: key,
          title: candidate.title,
          detail: candidate.detail,
          priority: candidate.priority,
          state: 'nueva',
          openCount: 1,
          firstSeenAt: now,
          lastSeenAt: now,
          stateChangedAt: now,
        })
        // Carrera entre instancias: otro proceso ya la creó. Se ignora sin notificar.
        if (!created) continue
        id = created.id
        isNew = true
        result.created += 1
      } else if (current.state === 'rechazada' || current.state === 'descartada') {
        continue
      } else if (current.state === 'completada') {
        id = current.id
        openCount = current.openCount + 1
        await this.store.update(id, {
          title: candidate.title,
          detail: candidate.detail,
          priority: candidate.priority,
          state: 'nueva',
          openCount,
          lastSeenAt: now,
          stateChangedAt: now,
          resolvedAt: null,
        })
        isNew = true
        result.reopened += 1
      } else {
        id = current.id
        // Una subida a prioridad alta (p. ej. de stock bajo a sin stock) cuenta como aviso nuevo.
        escalated = candidate.priority > current.priority
        await this.store.update(id, {
          title: candidate.title,
          detail: candidate.detail,
          priority: candidate.priority,
          lastSeenAt: now,
        })
      }

      if ((isNew || escalated) && shouldNotify(level, candidate.priority)) {
        await this.notifier.notify({
          userId,
          title: `Lumi: ${candidate.title}`,
          message: candidate.detail,
          // Un aviso por apertura y por prioridad: la clave de deduplicación los incluye.
          data: {
            executionId: `initiative:${id}:${openCount}:${candidate.priority}`,
            initiativeId: id,
            initiativeKind: candidate.kind,
          },
        })
        result.notified += 1
      }
    }

    // Lo que ya no aparece en las señales está resuelto. Excepciones: un tipo cuya lectura se truncó
    // (lo que falta puede seguir vigente) y un tipo que el usuario ya no puede ver (no se sabe; se oculta).
    for (const item of existing) {
      if (!OPEN_INITIATIVE_STATES.includes(item.state) || seen.has(item.dedupKey)) continue
      if (scope.truncated?.has(item.kind)) continue
      if (scope.allowed && !scope.allowed.has(item.kind)) continue
      await this.store.update(item.id, {
        state: 'completada',
        stateChangedAt: now,
        resolvedAt: now,
      })
      result.completed += 1
    }

    return result
  }
}

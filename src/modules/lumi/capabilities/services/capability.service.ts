import { AppError } from '../../../../common/errors/app.error.js'
import { buildPaginationMeta } from '../../../../common/utils/pagination.js'
import {
  capabilityKey,
  capabilityKeywords,
  capabilitySignature,
  compareKeywords,
} from '../domain/capability-signature.js'
import type { CapabilityTestStore } from '../domain/capability-test.store.js'
import type { CapabilityStore } from '../domain/capability.store.js'
import {
  canTransition,
  capabilityModule,
  MESSAGE_MAX_CHARS,
  NEED_MAX_CHARS,
  REPEAT_WINDOW_MS,
  type CapabilityModule,
  type CapabilityStatus,
  type ListCapabilitiesQuery,
  type LumiCapability,
  type UpdateCapabilityInput,
} from '../domain/capability.types.js'

export interface MissingCapabilityInput {
  userId: string
  conversationId: string | null
  message: string
  need: string
  module: string
}

export type RecordOutcome =
  | { recorded: true; capabilityId: string; created: boolean }
  /** La misma persona ya lo pidió hace poco: no se cuenta otra vez. */
  | { recorded: false; reason: 'repeat' }

const CANDIDATE_LIMIT = 50
const STATS_WINDOW_MS = 7 * 24 * 60 * 60_000
const DETAIL_REQUESTS = 20

/** Texto de una línea, sin caracteres de control, recortado. */
function clean(value: string, max: number): string {
  const printable = Array.from(value, (ch) => {
    const code = ch.charCodeAt(0)
    return code < 32 || code === 127 ? ' ' : ch
  }).join('')
  return printable.replace(/\s+/g, ' ').trim().slice(0, max)
}

function compatibleModules(a: CapabilityModule, b: CapabilityModule): boolean {
  return a === b || a === 'none' || b === 'none'
}

/**
 * Capability Manager (fase B). Registra lo que Lumi no sabe hacer, lo agrupa y lo pone a
 * disposición del panel. Nunca crea ni habilita herramientas.
 */
export class LumiCapabilityService {
  constructor(
    private readonly store: CapabilityStore,
    private readonly clock: () => Date = () => new Date(),
    private readonly suffix: () => string = () => Math.random().toString(16).slice(2, 8),
    /** Frases de prueba (fase D): en una fusión pasan al destino. */
    private readonly phrases?: Pick<CapabilityTestStore, 'movePhrases'>,
  ) {}

  /** Registra una petición sin herramienta. Una sola escritura lógica, sin modelo. */
  async recordMissing(input: MissingCapabilityInput): Promise<RecordOutcome> {
    const now = this.clock()
    const message = clean(input.message, MESSAGE_MAX_CHARS)
    const need = clean(input.need, NEED_MAX_CHARS)
    const module = capabilityModule(input.module)
    const keywords = capabilityKeywords(need, message)
    const signature = capabilitySignature(module, keywords)

    if (await this.store.hasRecentRequest(input.userId, signature, new Date(now.getTime() - REPEAT_WINDOW_MS))) {
      return { recorded: false, reason: 'repeat' }
    }

    let same: { capability: LumiCapability; score: number } | null = null
    let possible: { capability: LumiCapability; score: number } | null = null
    for (const capability of await this.store.findCandidates(keywords, CANDIDATE_LIMIT)) {
      const { match, score } = compareKeywords(keywords, capability.keywords)
      if (match === 'same' && compatibleModules(module, capability.module) && (!same || score > same.score)) {
        same = { capability, score }
      } else if (match !== 'none' && capability.status !== 'duplicate' && (!possible || score > possible.score)) {
        possible = { capability, score }
      }
    }

    let capabilityId: string
    let created = false
    if (same) {
      // Igual a una capacidad fusionada: la petición va a la que la absorbió.
      capabilityId = same.capability.mergedInto ?? same.capability.id
      await this.store.addRequest(capabilityId, message, now)
    } else {
      const capability = await this.store.create({
        key: capabilityKey(module, keywords, this.suffix()),
        title: clean(need || message, 120) || 'Petición sin título',
        module,
        signature,
        keywords,
        sample: message,
        possibleDuplicateOf: possible?.capability.id ?? null,
        now,
      })
      capabilityId = capability.id
      created = true
    }
    await this.store.insertRequest({
      capabilityId,
      userId: input.userId,
      conversationId: input.conversationId,
      message,
      need,
      module,
      signature,
      createdAt: now,
    })
    return { recorded: true, capabilityId, created }
  }

  async list(query: ListCapabilitiesQuery) {
    const { items, total } = await this.store.list(query)
    return {
      items: items.map(({ history: _history, spec: _spec, ...summary }) => summary),
      pagination: buildPaginationMeta(total, query.page, query.limit),
    }
  }

  async stats() {
    return this.store.stats(new Date(this.clock().getTime() - STATS_WINDOW_MS))
  }

  async get(id: string) {
    const capability = await this.require(id)
    const [requests, users] = await Promise.all([
      this.store.recentRequests(id, DETAIL_REQUESTS),
      this.store.distinctUsers(id),
    ])
    // Las peticiones se muestran sin autor: el panel solo necesita la frase y la fecha.
    return { capability, recentRequests: requests, distinctUsers: users }
  }

  async update(id: string, input: UpdateCapabilityInput, by: string): Promise<LumiCapability> {
    const current = await this.require(id)
    if (current.status === 'duplicate') throw AppError.conflict('La capacidad está fusionada con otra')
    const { spec, ...rest } = input
    await this.store.update(
      id,
      { ...rest, ...(spec ? { spec: { ...current.spec, ...spec } } : {}) },
      { at: this.clock(), by, action: 'updated' },
      this.clock(),
    )
    return this.require(id)
  }

  async changeStatus(id: string, to: CapabilityStatus, by: string): Promise<LumiCapability> {
    const current = await this.require(id)
    if (!canTransition(current.status, to)) {
      throw AppError.conflict(`Transición no permitida: ${current.status} → ${to}`)
    }
    await this.store.update(id, { status: to }, { at: this.clock(), by, action: 'status', from: current.status, to }, this.clock())
    return this.require(id)
  }

  /** Fusiona `sourceId` en `targetId`: la origen queda como `duplicate` y sus peticiones pasan al destino. */
  async merge(sourceId: string, targetId: string, by: string): Promise<LumiCapability> {
    if (sourceId === targetId) throw AppError.badRequest('No se puede fusionar una capacidad consigo misma')
    const [source, target] = await Promise.all([this.require(sourceId), this.require(targetId)])
    if (source.status === 'duplicate' || target.status === 'duplicate') {
      throw AppError.conflict('Una de las capacidades ya está fusionada')
    }
    if (source.toolName || ['testing', 'validated', 'enabled', 'disabled'].includes(source.status)) {
      throw AppError.conflict('No se puede fusionar una capacidad que ya tiene herramienta')
    }
    const now = this.clock()
    await this.store.absorb(targetId, sourceId, source.requestCount, source.samples, { at: now, by, action: 'merged_from', from: sourceId }, now)
    await this.phrases?.movePhrases(sourceId, targetId)
    await this.store.update(
      sourceId,
      { status: 'duplicate', mergedInto: targetId, possibleDuplicateOf: null },
      { at: now, by, action: 'merged_into', from: source.status, to: targetId },
      now,
    )
    return this.require(targetId)
  }

  private async require(id: string): Promise<LumiCapability> {
    const capability = await this.store.findById(id)
    if (!capability) throw AppError.notFound('Capacidad no encontrada')
    return capability
  }
}

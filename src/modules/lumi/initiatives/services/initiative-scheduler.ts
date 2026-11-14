import type { AutomationLock } from '../../automation/domain/automation.store.js'
import type { InitiativeEngine } from './initiative-engine.js'

export const INITIATIVE_LOCK_KEY = 'lumi:initiatives:lock'

export const DEFAULT_INITIATIVE_SCHEDULER_OPTIONS = {
  /** Las iniciativas no son urgentes al minuto: un barrido cada 30 minutos basta. */
  tickMs: 30 * 60_000,
  lockTtlMs: 10 * 60_000,
  firstRunDelayMs: 60_000,
} as const

/**
 * Ejecuta el motor de iniciativas en intervalos. Usa su propio lock para no solaparse con otra
 * instancia; dentro del proceso, un barrido en curso impide el siguiente.
 */
export class InitiativeScheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false

  constructor(
    private readonly engine: InitiativeEngine,
    private readonly lock: AutomationLock,
    private readonly options: { tickMs: number; lockTtlMs: number; firstRunDelayMs: number } = DEFAULT_INITIATIVE_SCHEDULER_OPTIONS,
    private readonly onError: (err: unknown) => void = () => {},
  ) {}

  start(): void {
    if (this.timer) return
    setTimeout(() => void this.tick().catch(this.onError), this.options.firstRunDelayMs).unref?.()
    this.timer = setInterval(() => void this.tick().catch(this.onError), this.options.tickMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Devuelve false si se omitió (ya en curso o lock ocupado por otra instancia). */
  async tick(): Promise<boolean> {
    if (this.running) return false
    this.running = true
    try {
      const acquired = await this.lock.tryAcquire(INITIATIVE_LOCK_KEY, this.options.lockTtlMs)
      if (!acquired) return false
      try {
        await this.engine.runOnce()
      } finally {
        await this.lock.release(INITIATIVE_LOCK_KEY)
      }
      return true
    } finally {
      this.running = false
    }
  }
}

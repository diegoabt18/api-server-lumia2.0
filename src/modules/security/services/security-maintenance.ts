/**
 * Tarea periódica de seguridad: marca como caducados los permisos temporales y las delegaciones
 * vencidas. Antes se hacía con dos updateMany en cada resolución de permisos (ruta de lectura).
 */
export class SecurityMaintenance {
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false

  constructor(
    private readonly task: () => Promise<unknown>,
    private readonly intervalMs = 10 * 60_000,
    private readonly onError: (err: unknown) => void = () => {},
  ) {}

  start(): void {
    if (this.timer) return
    setTimeout(() => void this.tick(), 10_000).unref?.()
    this.timer = setInterval(() => void this.tick(), this.intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Una pasada; si la anterior sigue en curso no se solapa. */
  async tick(): Promise<boolean> {
    if (this.running) return false
    this.running = true
    try {
      await this.task()
      return true
    } catch (err) {
      this.onError(err)
      return false
    } finally {
      this.running = false
    }
  }
}

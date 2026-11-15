/**
 * Qué herramientas puede usar el chat (fase E). Lo decide `lumi_capabilities` (estado `enabled`),
 * con una caché en memoria de 60 s: habilitar o deshabilitar tarda como mucho eso en llegar a
 * otras instancias del Server (en esta, `invalidate()` lo aplica al momento).
 *
 * Si la base de datos falla, se usa la última lista conocida. Si nunca se pudo leer, solo las
 * herramientas anteriores a la fase E: una herramienta nueva jamás se habilita por un error.
 */
export class LumiToolGate {
  private cache: { tools: ReadonlySet<string>; at: number } | null = null
  private loading: Promise<ReadonlySet<string>> | null = null

  constructor(
    private readonly load: () => Promise<string[]>,
    private readonly fallback: readonly string[],
    private readonly onError: (err: unknown) => void = () => undefined,
    private readonly ttlMs = 60_000,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  async enabledTools(): Promise<ReadonlySet<string>> {
    if (this.cache && this.clock() - this.cache.at < this.ttlMs) return this.cache.tools
    // Una sola lectura a la vez aunque lleguen muchos turnos juntos.
    this.loading ??= this.refresh().finally(() => {
      this.loading = null
    })
    return this.loading
  }

  invalidate(): void {
    this.cache = null
  }

  private async refresh(): Promise<ReadonlySet<string>> {
    try {
      const tools = new Set(await this.load())
      this.cache = { tools, at: this.clock() }
      return tools
    } catch (err) {
      this.onError(err)
      return this.cache?.tools ?? new Set(this.fallback)
    }
  }
}

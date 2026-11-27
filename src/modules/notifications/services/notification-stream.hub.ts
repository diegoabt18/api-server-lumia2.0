/**
 * Canal en tiempo real de notificaciones. Mantiene las conexiones SSE abiertas por usuario y
 * reenvía cada notificación nueva. Con un bus (Redis pub/sub, obligatorio en producción) cada
 * notificación llega a las conexiones de todas las instancias del servidor; sin bus (desarrollo,
 * pruebas) solo a las de esta instancia.
 * Sin conexión abierta la notificación queda guardada y se ve al volver.
 */
export type HubSend = (event: string, data: unknown) => void

/** Reparto entre instancias. */
export interface NotificationBus {
  publish(userId: string, payload: unknown): Promise<void>
  onMessage(deliver: (userId: string, payload: unknown) => void): void
  close(): Promise<void>
}

export class NotificationStreamHub {
  private readonly clients = new Map<string, Set<HubSend>>()

  constructor(
    private readonly bus?: NotificationBus,
    private readonly onBusError?: (err: unknown) => void,
  ) {
    bus?.onMessage((userId, payload) => this.deliver(userId, payload))
  }

  subscribe(userId: string, send: HubSend): () => void {
    const set = this.clients.get(userId) ?? new Set<HubSend>()
    set.add(send)
    this.clients.set(userId, set)
    return () => {
      set.delete(send)
      if (set.size === 0 && this.clients.get(userId) === set) this.clients.delete(userId)
    }
  }

  publish(userId: string, payload: unknown): void {
    if (!this.bus) {
      this.deliver(userId, payload)
      return
    }
    // Si Redis no responde, al menos las conexiones de esta instancia la reciben al momento.
    this.bus.publish(userId, payload).catch((err) => {
      this.onBusError?.(err)
      this.deliver(userId, payload)
    })
  }

  async close(): Promise<void> {
    await this.bus?.close()
  }

  get connections(): number {
    let total = 0
    for (const set of this.clients.values()) total += set.size
    return total
  }

  private deliver(userId: string, payload: unknown): void {
    for (const send of this.clients.get(userId) ?? []) {
      try {
        send('notification', payload)
      } catch {
        // Conexión caída: se elimina en su evento "close".
      }
    }
  }
}

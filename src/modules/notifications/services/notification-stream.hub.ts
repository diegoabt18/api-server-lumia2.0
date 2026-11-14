/**
 * Canal en tiempo real de notificaciones. Mantiene las conexiones SSE abiertas por usuario y
 * reenvía cada notificación nueva. Es en memoria: vale para una instancia del servidor, que es el
 * despliegue actual. Con varias instancias, este canal debe pasar por Redis pub/sub.
 * Sin conexión abierta la notificación queda guardada y se ve al volver.
 */
export type HubSend = (event: string, data: unknown) => void

export class NotificationStreamHub {
  private readonly clients = new Map<string, Set<HubSend>>()

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
    for (const send of this.clients.get(userId) ?? []) {
      try {
        send('notification', payload)
      } catch {
        // Conexión caída: se elimina en su evento "close".
      }
    }
  }

  get connections(): number {
    let total = 0
    for (const set of this.clients.values()) total += set.size
    return total
  }
}

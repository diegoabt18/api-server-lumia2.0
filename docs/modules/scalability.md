# Escalabilidad — Fase 8

**Estado:** 📋 Planificado (solo diseño, sin implementar)  
**Roadmap:** [../roadmap.md](../roadmap.md#fase-8--escalabilidad-e-infraestructura-avanzada)

---

## Principio

El monolito modular actual escala verticalmente en un ThinkCentre con Docker Compose. **No anticipar infraestructura distribuida** hasta tener métricas que lo justifiquen.

---

## Capacidad estimada Fase 1 (single node)

| Recurso | Config sugerida ThinkCentre | Capacidad orientativa |
|---------|----------------------------|------------------------|
| API (1 instancia) | 2 CPU / 1GB RAM | Miles req/min catálogo |
| MongoDB | 2GB RAM, SSD | Millones documentos catálogo |
| Redis | 256MB | Cache + rate limit |

---

## Triggers de escalado

| Señal | Acción recomendada |
|-------|-------------------|
| CPU API > 70% sostenido | Segunda instancia API + balanceador |
| Mongo I/O saturado | Índices, read replicas Atlas |
| Jobs bloquean API | Extraer workers (Fase 8b) |
| Uploads pesados en API | MinIO / Cloudflare R2 |
| Equipo > 3 devs en backend | Evaluar microservicio payments |

---

## Opción A — Múltiples instancias API (mismo host)

```
cloudflared → nginx/caddy :3001/:3002 → api-1, api-2
                    ↓
              mongo + redis (shared)
```

Requisitos:

- API **stateless** (ya cumplido — sesiones en Mongo, no en memoria)
- Redis para rate limit compartido (ya soportado)
- Sticky sessions **no** necesarias (JWT + cookies)

---

## Opción B — Docker Swarm

```yaml
# Futuro: docker-stack.yml
services:
  api:
    deploy:
      replicas: 2
```

Cuándo: 2+ nodos físicos o VMs.

---

## Opción C — Kubernetes

Cuándo:

- Equipo con experiencia K8s
- Swarm insuficiente
- Necesidad de auto-scaling por métricas

**No recomendado** para un solo ThinkCentre.

---

## Colas de mensajes

| Tecnología | Caso de uso |
|------------|-------------|
| BullMQ + Redis | Emails, webhooks retry, expire-orders |
| RabbitMQ | Integraciones externas pesadas |
| NATS | Event bus multi-servicio |

Patrón:

```
API → publish event → Worker → Mongo / external API
```

Eventos candidatos: `order.paid`, `inventory.updated`, `notification.send`.

---

## Microservicios (extracción gradual)

Orden sugerido si algún día se divide:

1. **payments** — webhooks, MP, aislable
2. **production** — dominio grande, usuarios admin only
3. **notifications** — email/SMS/push

Contrato: REST interno o cola; frontend **nunca** cambia (`api.lumiadalistore.com`).

---

## Object storage

| Uso | Solución |
|-----|----------|
| Imágenes producto | CDN GitHub / Cloudflare R2 (lumia ya usa CDN env) |
| Uploads admin | MinIO local o R2 |
| Backups | R2 / S3 Glacier |

---

## WebSockets

Casos: notificaciones in-app real-time, estado pedido live.

Opciones:

- `@fastify/websocket` en monolito
- Servicio dedicado + Redis pub/sub

Frontend Nuxt: polling suficiente hasta Fase 8.

---

## CDN y cache

| Capa | Herramienta |
|------|-------------|
| Frontend | Cloudflare Pages ✅ |
| API GET público | Cloudflare cache rules (`/api/products`, `/api/categories`) |
| Redis | Cache aplicación (precios, settings) |

---

## Checklist antes de escalar

- [ ] Métricas baseline en `/health/metrics` + logs
- [ ] Load test (k6) documentado
- [ ] Backups probados
- [ ] Runbook incidentes ([operations.md](./operations.md))

---

## Diagrama evolución

```
Hoy (Fase 1):
  CF Tunnel → 1 API → 4 MongoDB + Redis

Mediano plazo (Fase 8a):
  CF → LB → N×API → Mongo + Redis

Largo plazo (Fase 8b):
  CF → Gateway → [API | Payments | Workers] → Message Queue → DBs
```

La transición debe ser **transparente** para `lumiadalistore.com` y `api.lumiadalistore.com`.

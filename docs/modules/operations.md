# Operaciones — Fase 7

**Estado:** 📋 Planificado  
**Roadmap:** [../roadmap.md](../roadmap.md#fase-7--observabilidad-y-operaciones)

---

## Objetivo

Operación confiable en ThinkCentre: backups, jobs, monitoring y recuperación ante fallos.

---

## Ya disponible (Fase 1)

| Herramienta | Ubicación |
|-------------|-----------|
| Logs JSON (Pino) | stdout / Docker logs |
| Health checks | `/health`, `/health/ready`, `/health/live` |
| Métricas básicas | `/health/metrics` |
| Backup manual Mongo | `npm run backup:mongo` |
| Seed manual | `npm run seed` |
| Log rotation Docker | `docker-compose.prod.yml` json-file |
| Restart automático | `restart: unless-stopped` |

---

## Jobs planificados

| Script | Frecuencia | Propósito |
|--------|------------|-----------|
| `backup-mongo.ts` | Diario 02:00 | Dump 4 DBs → `./backups/` |
| `expire-orders.ts` | Cada hora | Órdenes MP/manual vencidas |
| `migrate.ts` | On-demand | Schema migrations (migrate-mongo) |
| `sync-permissions.ts` | On-demand | Registry RBAC (opcional) |

### Ejecución en Windows (desarrollo)

```powershell
# Task Scheduler — backup diario
schtasks /create /tn "Lumia Mongo Backup" /tr "npm run backup:mongo" /sc daily /st 02:00
```

### Ejecución en ThinkCentre (producción)

```bash
# crontab -e
0 2 * * * cd /opt/lumia-api && npm run backup:mongo
0 * * * * cd /opt/lumia-api && node dist/scripts/expire-orders.js
```

---

## Observabilidad avanzada (opcional)

| Stack | Uso |
|-------|-----|
| Prometheus + Grafana | CPU, memoria, request rate |
| Loki | Agregación logs Pino |
| Sentry | Error tracking frontend + API |
| UptimeRobot / CF Health Checks | Alertas externas |

Integración Fastify: `@fastify/otel` o exporter Prometheus en Fase 7b.

---

## Recuperación ante fallos

### Escenario: MongoDB corrupto

1. Detener API: `docker compose down api`
2. Restaurar backup: `mongorestore --uri=... ./backups/<timestamp>/`
3. Verificar: `GET /health/ready`
4. Levantar API

### Escenario: Redis caído

API degrada gracefully (Fase 1): rate limit en memoria, sin cache. No requiere intervención urgente.

### Escenario: Tunnel caído

1. Verificar servicio cloudflared en host
2. `cloudflared tunnel run lumia-api`
3. Frontend sigue en Cloudflare Pages — solo API afectada

### Escenario: Migración ThinkCentre

Ver [cloudflare-tunnel.md](../cloudflare-tunnel.md#migración-al-thinkcentre).

---

## Retención de backups

| Entorno | Retención sugerida |
|---------|-------------------|
| Desarrollo | 7 días |
| Producción | 30 días local + copia offsite (R2/S3) |

---

## Checklist producción

- [ ] `DB_SEED_DISABLED=true`
- [ ] `JWT_SECRET` único y rotado manualmente si comprometido
- [ ] Backups automatizados y probados (restore test mensual)
- [ ] `.env.production` fuera de git
- [ ] Mongo Express **no** expuesto en prod
- [ ] Logs con rotación configurada

# Roadmap — Lumia API

Documento maestro de fases. Refleja qué está **implementado**, qué queda **pendiente** y de dónde se portó desde el monolito lumia.

**Referencia monolito:** `../lumia` (Nuxt)  
**API actual:** este repositorio

---

## Resumen de fases

| Fase | Nombre | Estado | Notas |
|------|--------|--------|-------|
| **1** | Núcleo productivo | ✅ Completada | Auth, catálogo, pedidos, Docker |
| **2** | Checkout y pagos | ✅ Completada | Carrito, pago manual, expiración (sin pasarela online) |
| **3** | Tienda pública | ✅ Completada | Store, favoritos, feedback, promociones, OAuth |
| **4** | Panel admin (API) | ✅ MVP+ | ~100+ rutas admin (productos, pedidos, pricing, usuarios) |
| **5** | Producción y costeo | ✅ MVP+ | Materiales, recetas, aprobaciones, impacto, equivalencias |
| **6** | Auth avanzada y RBAC | ✅ MVP+ | 2FA, roles, temporales, delegaciones, overrides |
| **7** | Observabilidad y operaciones | 📋 Pendiente | Cron, alertas, Prometheus/Sentry |
| **8** | Escalabilidad avanzada | 📋 Futuro | Colas, K8s, microservicios |

**Leyenda:** ✅ implementado · 📋 pendiente · 🟡 parcial / stub (p. ej. generación de imágenes)

---

## Fase 1 — Núcleo productivo (completada)

### Entregado

- Fastify + TypeScript + Docker + Redis + 4 MongoDB
- Auth: login, refresh, logout, me (JWT + cookies `lumia_*`)
- Catálogo: products, categories (lectura pública)
- Ventas: crear pedido, consultar pedido
- Health, métricas básicas, Swagger, CI/GHCR
- Cloudflare Tunnel documentado

### Endpoints activos

Ver [README.md](../README.md#endpoints-principales) y Swagger `/docs`.

---

## Fase 2 — Checkout y pagos (completada)

**Alcance:** carrito persistente, checkout end-to-end, **pago manual**, cancelación de pedidos, script de expiración.

**Fuera de alcance:** pasarela de pago online (MercadoPago, Stripe, etc.).

### Entregado

| Componente | Rutas |
|------------|-------|
| Carrito | `GET/PATCH/POST/DELETE /api/cart*` |
| Checkout | `POST /api/orders/create` |
| Pago manual | `POST /api/payments/manual` |
| Órdenes | `GET /api/orders/list`, `by-number`, `cancel`, `cancel-request` |
| Expiración | `npm run expire:orders` |

### Variables

```env
ORDER_PAYMENT_TTL_HOURS=24
ORDER_MANUAL_PAYMENT_TTL_HOURS=72
```

Documentación: [modules/payments.md](./modules/payments.md)

---

## Fase 3 — Tienda pública (completada)

Store settings, banners, promociones, favoritos, notificaciones, registro/perfil, Google OAuth, feedback, newsletter.

Rutas: `store-public.routes.ts`, `store.routes.ts`

Documentación: [modules/store-public.md](./modules/store-public.md)

---

## Fase 4 — Panel admin (MVP+)

**~100+ endpoints** en `admin.routes.ts`: dashboard, analytics, productos, categorías, pedidos, promociones, banners, inventario, staff, registry, feedback, **usuarios generales**, **audit-log**, **pricing**, **cost-summary por producto/SKU**.

### Pendiente menor

- Generación de imágenes (stub)
- Paridad 1:1 con los ~200 endpoints del monolito (edge cases)

Documentación: [modules/admin.md](./modules/admin.md)

---

## Fase 5 — Producción y costeo (MVP+)

CRUD materiales, proveedores, recetas, unidades, config, dashboard, audit, **equivalencias**, **costos indirectos**, **aprobaciones de precio**, **impacto**, **costing extendido**, sub-recursos de receta, **conversión pública de unidades**.

Rutas: `production-admin.routes.ts`, `production-public.routes.ts`

Documentación: [modules/production.md](./modules/production.md)

---

## Fase 6 — Auth avanzada y RBAC (MVP+)

Google OAuth, 2FA TOTP, roles/permisos CRUD, **RBAC enterprise** (temporales, overrides, delegaciones, templates, condicionales, approvals, webhooks, scheduled changes, transfer, cache, bulk), dashboards, audit, aliases legacy `/admin/roles`.

Rutas: `security.routes.ts`, `security-extended.routes.ts`

Documentación: [modules/auth-advanced.md](./modules/auth-advanced.md)

---

## Fase 2 — Checkout y pagos (referencia histórica — ver sección completada arriba)

<details>
<summary>Detalle original del plan (archivado)</summary>

**Objetivo:** Completar el flujo de compra que el frontend Nuxt ya consume en lumia.

### Alcance original

| Componente | Base MongoDB | Colecciones | Origen lumia |
|------------|--------------|-------------|--------------|
| Carrito | `sales_db` | `carts` | `server/core/sales/` |
| Pago manual | `sales_db` | `payments` | `server/api/payments/manual.post.ts` |
| Expiración de órdenes | `sales_db` | `orders` | TTL + jobs |

### Endpoints portados

```
GET    /api/cart
POST   /api/cart/items
PATCH  /api/cart/items
DELETE /api/cart/items
POST   /api/payments/manual
GET    /api/orders/list
GET    /api/orders/by-number/:orderNumber
POST   /api/orders/:id/cancel
```

</details>

---

## Fase 2 legacy — texto archivado (MercadoPago eliminado del alcance)

<details>
<summary>No implementado — fuera de scope</summary>

Pasarela online, webhooks MP y create-preference **no están en el roadmap activo**.

</details>

---

## Fase 3 legacy — referencia

<details>
<summary>Detalle original Fase 3</summary>

| Módulo | Base | Colecciones | Endpoints lumia |
|--------|------|-------------|-----------------|
| Store config | `identity_db` | `store_*_settings` | `/api/store/*` |
| Banners | `catalog_db` | `store_banners` | `/api/store/banners` |
| Promociones | `catalog_db` | `promotions` | Resolución en listado productos |
| Favoritos | `sales_db` | `user_favorites` | `/api/account/favorites` |
| Notificaciones | `identity_db` | `notifications` | `/api/notifications/*` |
| Cuenta | `identity_db` | `users` | `/api/account/preferences`, profile |
| Feedback | `sales_db` + `catalog_db` | reviews, questions, answers | `/api/products/:id/feedback/*` |
| Pre-pedidos | `sales_db` | `pre_orders` | WhatsApp flow |

### Endpoints a portar

```
GET  /api/store/banners
GET  /api/store/shipping-settings
GET  /api/store/currency-settings
GET  /api/store/customer-settings
GET  /api/account/favorites
POST /api/account/favorites/toggle
PATCH /api/account/preferences
GET  /api/notifications
PATCH /api/notifications/:id/read
GET  /api/products/:id/reviews
POST /api/products/:id/reviews
GET  /api/products/:id/questions
POST /api/auth/register
GET  /api/auth/nickname-availability
PATCH /api/auth/profile
GET  /api/auth/permissions
GET  /api/auth/sessions
POST /api/auth/sessions/revoke
POST /api/auth/logout-all
```

### Mejoras sobre lumia

- Promociones: portar `server/core/pricing/promotion-resolution.ts`
- Productos: badges bestseller/popular ya parcialmente en Fase 1
- Paginación y contratos de respuesta idénticos al monolito

### Criterios de aceptación

- [ ] Frontend Nuxt funciona sin cambiar contratos JSON
- [ ] Store settings leídos desde Mongo (no env vars)
- [ ] Registro local condicionado por `AUTH_LOCAL_ENABLED`

### Documentación

- [docs/modules/store-public.md](./modules/store-public.md)

</details>

---

## Referencia archivada (detalle original fases 4–8)

<details>
<summary>Texto histórico del plan — consultar solo si hace falta detalle fino</summary>

## Fase 4 — Panel admin (API)

**Objetivo:** Exponer la API administrativa (~200 endpoints) como módulos incrementales.

### Estrategia de portado

No portar los 200 endpoints de golpe. Orden recomendado:

1. **Dashboard** — stats, analytics básico  
2. **Productos admin** — CRUD productos, variantes, opciones, inventario  
3. **Categorías, promociones, banners**  
4. **Pedidos admin** — listado, cancelación, depósitos, factura  
5. **Store settings admin**  
6. **Staff users** — usuarios con rol staff  
7. **Registry** — modules, services, permissions sync  

### Protección de endpoints

En lumia: `defineServiceApi` + colección `services` en MongoDB.

**Recomendación Fase 4:** middleware estático en Fastify mapeando ruta → permiso, con fallback opcional a Mongo:

```typescript
// Futuro: src/modules/admin/middleware/permission-map.ts
{ method: 'GET', path: '/api/admin/products', permission: 'products.read' }
```

Fuente permisos: `shared/permission-registry.ts` (lumia) → ya portado en `src/common/permissions/registry.ts`.

### Endpoints admin (muestra — ver lumia `server/database/seed/services.seed.ts`)

```
GET    /api/admin/dashboard/stats
GET    /api/admin/products
POST   /api/admin/products
PATCH  /api/admin/products/:id
DELETE /api/admin/products/:id
GET    /api/admin/orders
PATCH  /api/admin/orders/:id/cancel
... (~200 rutas)
```

### Criterios de aceptación

- [ ] Todo endpoint admin requiere `admin.access` mínimo
- [ ] Permisos granulares por recurso (`products.create`, etc.)
- [ ] Respuestas compatibles con panel admin Nuxt existente
- [ ] Sin bootstrap destructivo al arrancar (seeds vía CLI)

### Documentación

- [docs/modules/admin.md](./modules/admin.md)

---

## Fase 5 — Producción y costeo

**Objetivo:** Portar el bounded context `production_db` — materiales, recetas, costos, aprobaciones de precio.

### Base de datos

**DB:** `production_db` (ya conectada en Fase 1, sin endpoints de negocio)

### Colecciones (19)

Ver `src/modules/production/index.ts` y lumia `docs/modules/production/database.md`:

```
materials, material_price_history, suppliers, material_suppliers,
recipes, recipe_versions, cost_sheets, cost_sheets_v2,
production_config, labor_costs, production_costs, packaging_costs,
service_costs, indirect_costs, price_approvals, cost_impacts,
production_audit_log, unit_of_measures, unit_equivalences
```

### Integración cross-context

| Desde | Hacia | Uso |
|-------|-------|-----|
| `catalog_db.variants` | `production_db.recipes` | `production_recipe_id` |
| `catalog_db` | `production_db` | `variant_cost_snapshots` |
| Admin pricing | catalog + production | calculate, simulate, suggest-margin |

### Endpoints a portar (~60 en lumia)

```
GET    /api/admin/materials
POST   /api/admin/materials
GET    /api/admin/recipes
POST   /api/admin/recipes
POST   /api/admin/pricing/calculate
POST   /api/admin/products/:id/cost-summary
GET    /api/production/unit-conversion/*
```

### Criterios de aceptación

- [ ] Recetas vinculadas a variantes SKU
- [ ] Costeo coherente con lumia (mismas fórmulas en `shared/production/`)
- [ ] Auditoría en `production_audit_log`

### Scaffolding existente

- `src/modules/production/index.ts`
- `GET /api/production/status` — solo diagnóstico

### Documentación

- [docs/modules/production.md](./modules/production.md)

---

## Fase 6 — Auth avanzada y RBAC enterprise

**Objetivo:** Paridad con el sistema de seguridad avanzado de lumia (solo si el negocio lo usa).

### Funcionalidades lumia no portadas

| Feature | Colecciones identity_db | Endpoints |
|---------|-------------------------|-----------|
| Google OAuth | `users.googleId` | `/api/auth/google/callback` |
| 2FA TOTP (admin) | `users.twoFactor` | `/api/auth/2fa/*` |
| Delegación de roles | `role_delegations` | `/api/admin/security/delegations/*` |
| Permisos temporales | `temporal_permissions` | `/api/admin/security/temporal/*` |
| Overrides por usuario | `user_permission_overrides` | `/api/admin/security/overrides/*` |
| Flujos de aprobación | `approval_requests` | maker-checker |
| Webhooks RBAC | `webhooks` | eventos de permisos |
| Auditoría auth | `auth_audit_log`, `permission_audit` | compliance |
| Risk engine | sessions fields | refresh anomaly detection |

### Recomendación

Implementar **solo lo que el panel admin use hoy**:

1. Google OAuth (si login social está activo en prod)
2. 2FA admin (si hay admins con 2FA enabled)
3. RBAC enterprise — **evaluar uso real** antes de portar ~80 endpoints security

### Simplificación aceptable

- Mantener RBAC por rol + permisos en código (Fase 1)
- Registry dinámico `services`/`modules` → opcional, preferir mapa estático

### Variables

```env
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
AUTH_LOCAL_ENABLED=true
```

### Documentación

- [docs/modules/auth-advanced.md](./modules/auth-advanced.md)

---

## Fase 7 — Observabilidad y operaciones

**Objetivo:** Operación profesional en ThinkCentre sin cambiar arquitectura de despliegue.

### Alcance

| Área | Herramienta sugerida | Estado Fase 1 |
|------|---------------------|---------------|
| Logs JSON | Pino | ✅ |
| Health / ready / live | Fastify routes | ✅ |
| Métricas básicas | `/health/metrics` in-memory | ✅ |
| Rotación logs Docker | json-file max-size | ✅ prod compose |
| Backups Mongo | `scripts/backup-mongo.ts` | ✅ manual |
| Alertas | — | 📋 |
| Prometheus + Grafana | — | 📋 |
| Tracing (OpenTelemetry) | — | 📋 |
| Error tracking (Sentry) | — | 📋 |
| Uptime monitoring | Cloudflare / UptimeRobot | 📋 |

### Jobs operativos (futuro)

```
scripts/
  backup-mongo.ts      ✅ existe
  migrate.ts           📋 migrate-mongo cuando schema se estabilice
  expire-orders.ts     📋 cron — órdenes MP/manual vencidas
  sync-permissions.ts  📋 opcional — registry DB
```

### Cron / Workers

- **Fase 7a:** cron en host (`Task Scheduler` Windows / systemd ThinkCentre)
- **Fase 8:** BullMQ + Redis para colas persistentes

### Documentación

- [docs/modules/operations.md](./modules/operations.md)

---

## Fase 8 — Escalabilidad e infraestructura avanzada

**Objetivo:** Preparar crecimiento **sin implementar aún**. La arquitectura Fase 1 ya lo permite (monolito modular stateless).

### Cuándo considerar cada pieza

| Tecnología | Trigger | Acción |
|------------|---------|--------|
| Múltiples instancias API | >1 servidor o CPU saturada | Cloudflare load balance + N tunnels o reverse proxy local |
| Docker Swarm | 2+ nodos ThinkCentre | `docker stack deploy` |
| Kubernetes | Equipo DevOps dedicado | Solo si Swarm no alcanza |
| RabbitMQ / NATS | Workers pesados, eventos async | Extraer workers del monolito |
| MinIO / R2 | Uploads de imágenes en API | CDN + object storage |
| WebSockets | Notificaciones real-time | Fastify `@fastify/websocket` o Socket.io |
| Cache distribuida | Multi-instancia API | Redis cluster |
| CDN assets API | Tráfico global alto | Cloudflare cache rules |
| Microservicios | Dominio muy grande | Extraer payments o production primero |

### Principio rector

> Permanecer en **monolito modular** hasta que un dominio tenga equipo/tráfico que lo justifique.

### Diagrama objetivo (futuro lejano)

```
                    Cloudflare
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
      API x N        Workers         MinIO/R2
          │              │              │
          └────── Redis / Message Queue ─┘
                         │
          ┌──────────────┼──────────────┬──────────────┐
          ▼              ▼              ▼              ▼
    identity_db    catalog_db      sales_db    production_db
```

### Documentación

- [docs/modules/scalability.md](./modules/scalability.md)

---

## Mapa de módulos — estado actual

```
src/modules/
├── identity/     ✅ Fase 1 — auth, users, sessions
├── catalog/      ✅ Fase 1 — products, categories (lectura)
├── sales/        ✅ Fase 1 — orders (básico)
│                 📋 Fase 2 — cart, payments
│                 📋 Fase 3 — favorites, feedback
├── payments/     🏗 Fase 2 — interface only
├── production/   🏗 Fase 5 — status endpoint only
├── shipping/     📋 Fase 2/3 — no folder yet
├── coupons/      📋 Fase 3 — promotions engine
├── notifications/📋 Fase 3
├── analytics/    📋 Fase 4
└── admin/        📋 Fase 4 — no folder yet
```

---

## Orden de implementación recomendado

```
Fase 1 ✅
   ↓
Fase 2 (cart + MercadoPago)     ← desbloquea ventas reales
   ↓
Fase 3 (store + cuenta)         ← paridad frontend tienda
   ↓
Fase 4 (admin incremental)      ← operación día a día
   ↓
Fase 5 (production)             ← si usan costeo en prod
   ↓
Fase 6 (auth/RBAC avanzado)      ← según necesidad real
   ↓
Fase 7 (observabilidad)
   ↓
Fase 8 (escala)                  ← solo bajo demanda
```

---

## Qué NO hacer (anti-patterns detectados en lumia)

1. **Bootstrap destructivo al arrancar** — seeds solo vía `npm run seed`
2. **Microservicios prematuros** — mantener monolito modular
3. **cloudflared dentro de Docker API** — tunnel siempre en el host
4. **CORS `*`** — solo dominios configurados
5. **Hardcodear secretos** — Twelve-Factor siempre
6. **Duplicar colección `permissions`** híbrida sin plan de migración
7. **Transacciones cross-DB** — diseñar compensaciones/sagas

---

## Referencias

| Documento | Contenido |
|-----------|-----------|
| [README.md](../README.md) | Inicio rápido, arquitectura actual |
| [cloudflare-tunnel.md](./cloudflare-tunnel.md) | Tunnel y migración ThinkCentre |
| [modules/payments.md](./modules/payments.md) | Pago manual — Fase 2 |
| [modules/store-public.md](./modules/store-public.md) | Tienda pública — Fase 3 |
| [modules/admin.md](./modules/admin.md) | Admin API — Fase 4 |
| [modules/production.md](./modules/production.md) | Costeo — Fase 5 |
| [modules/auth-advanced.md](./modules/auth-advanced.md) | OAuth, 2FA, RBAC — Fase 6 |
| [modules/operations.md](./modules/operations.md) | Backups, cron, monitoring — Fase 7 |
| [modules/scalability.md](./modules/scalability.md) | K8s, colas, microservicios — Fase 8 |
| lumia `docs/modules/` | Documentación de negocio original |

</details>

---

*Última actualización: Fases 1–6 MVP+ implementadas; Fases 7–8 pendientes.*

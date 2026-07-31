# Lumia API

Backend eCommerce desacoplado para tu tienda online.

API pública: **https://api.tu-dominio.com** (configurable vía `APP_URL`)

Arquitectura modular compatible con un monolito Nuxt existente (p. ej. `../lumia`), reutilizando las **4 bases MongoDB** por bounded context.

---

## Stack

| Capa | Tecnología |
|------|------------|
| Runtime | Node.js 22 LTS |
| Framework | Fastify 5 |
| Lenguaje | TypeScript |
| Validación | Zod |
| Base de datos | MongoDB 7 (4 DBs) |
| Cache / Rate limit | Redis 7 |
| Auth | JWT + Refresh rotativo |
| Docs | Swagger / OpenAPI |
| Logs | Pino (JSON) |
| Tests | Vitest |
| Contenedores | Docker + Compose |
| CI | GitHub Actions → GHCR |
| Exposición | Cloudflare Tunnel |

---

## Arquitectura

```
Internet
   ↓
https://tu-dominio.com            (Cloudflare Pages — Nuxt 3)
   ↓ HTTPS + credentials
https://api.tu-dominio.com        (Cloudflare Tunnel)
   ↓
cloudflared (host Windows / Linux)
   ↓
Docker: API :3001
   ↓
┌─────────────┬─────────────┬─────────────┬──────────────────┐
│ identity_db │ catalog_db  │  sales_db   │  production_db   │
│ users       │ products    │ orders      │ materials        │
│ sessions    │ categories  │ carts       │ recipes          │
│ roles/RBAC  │ variants    │ payments    │ cost_sheets      │
└─────────────┴─────────────┴─────────────┴──────────────────┘
        Redis (cache, rate limit, sesiones)
```

### Compatibilidad con lumia

| Aspecto | Decisión |
|---------|----------|
| Prefijo rutas | `/api/*` (igual que Nitro) |
| Cookies | `lumia_access`, `lumia_refresh` |
| Bases MongoDB | `identity_db`, `catalog_db`, `sales_db`, `production_db` |
| Colecciones | Mismas que el monolito lumia |
| Dominio entities | Portadas/adaptadas desde `server/core/` |

---

## Estructura del proyecto

```
src/
├── config/           # env, logger
├── database/         # conexiones Mongo/Redis, repositorio base
├── modules/
│   ├── identity/     # auth, users, sessions, JWT
│   ├── catalog/      # products, categories
│   ├── sales/        # orders
│   ├── production/   # materiales, recetas, costeo
│   ├── security/     # RBAC enterprise
│   ├── store/        # configuración tienda
│   ├── notifications/
│   └── payments/     # pago manual
├── common/           # permisos, errores, utils
├── plugins/          # Fastify plugins
└── routes/           # registro de endpoints
docker/               # init MongoDB
docs/                 # Cloudflare Tunnel, arquitectura
scripts/              # seed, backup
tests/
```

---

## Inicio rápido (Windows + Docker)

### 1. Clonar e instalar

```powershell
cd ruta/a/lumia-api
npm install
```

### 2. Variables de entorno

```powershell
copy .env.example .env.development
# Editar APP_URL, FRONTEND_URL, JWT_SECRET, URIs Mongo, etc.
```

Ver plantilla completa en [`.env.example`](.env.example). Los archivos `.env.development` y `.env.production` **no se commitean** (están en `.gitignore`).

### 3. Levantar infraestructura

```powershell
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
```

Servicios:
- API: http://localhost:3001
- Swagger: http://localhost:3001/docs
- Mongo Express (solo dev): http://localhost:8081

### 4. Seed de datos demo

```powershell
npm run seed
```

El script imprime las credenciales demo en consola (usuario admin de prueba).

### 5. Cloudflare Tunnel

Ver guía completa: [docs/cloudflare-tunnel.md](docs/cloudflare-tunnel.md)

```powershell
cloudflared tunnel run <nombre-de-tu-tunnel>
```

Verificar (reemplaza con tu dominio configurado):

```powershell
curl https://api.tu-dominio.com/health
curl https://api.tu-dominio.com/api/products
```

---

## Endpoints principales

| Método | Ruta | Auth | Descripción |
|--------|------|------|-------------|
| GET | `/health` | No | Health check |
| GET | `/health/ready` | No | Readiness (Mongo + Redis) |
| GET | `/health/live` | No | Liveness |
| GET | `/health/metrics` | No | Métricas básicas |
| POST | `/api/auth/login` | No | Login email/password |
| POST | `/api/auth/refresh` | Cookie | Rotación refresh token |
| POST | `/api/auth/logout` | Cookie | Cerrar sesión |
| GET | `/api/auth/me` | Sí | Usuario actual |
| GET | `/api/products` | No | Listado productos |
| GET | `/api/products/:id` | No | Detalle (id o slug) |
| GET | `/api/categories` | No | Categorías |
| GET | `/api/categories/:id` | No | Categoría |
| POST | `/api/orders/create` | Sí | Crear pedido |
| POST | `/api/orders` | Sí | Alias crear pedido |
| GET | `/api/orders/:id` | Sí | Detalle pedido |

Documentación interactiva: `/docs`

---

## Variables de entorno

| Grupo | Variables clave |
|-------|-----------------|
| App | `APP_URL`, `FRONTEND_URL`, `NODE_ENV`, `PORT` |
| Mongo | `MONGO_AUTH_URI`, `MONGO_CATALOG_URI`, `MONGO_SALES_URI`, `MONGO_PRODUCTION_URI` |
| Redis | `REDIS_URL`, `REDIS_ENABLED` |
| JWT | `JWT_SECRET`, `JWT_ACCESS_EXPIRES_IN`, `JWT_REFRESH_EXPIRES_IN` |
| Cookies | `COOKIE_DOMAIN=.tu-dominio.com`, `COOKIE_SECURE=true` |
| CORS | `CORS_ORIGINS` |
| Auth | `AUTH_LOCAL_ENABLED`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |

Plantilla versionada: `.env.example` (copiar a `.env.development` / `.env.production` en local).

---

## Desarrollo local (sin Docker para la API)

```powershell
# Solo Mongo + Redis en Docker
docker compose up -d mongo redis

# API en el host
npm run dev
```

---

## Producción

```powershell
copy .env.example .env.production
# Completar secretos y dominios reales (nunca commitear este archivo)

docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

Despliegue: copiar proyecto + `.env.production` + credenciales Cloudflare Tunnel en el servidor. Ajustar DNS y variables según tu dominio.

---

## Tests

```powershell
npm run test
npm run test:coverage
npm run lint
npm run typecheck
```

---

## Diagramas

### Flujo de autenticación

```
Cliente (tu-dominio.com)
   │ POST /api/auth/login
   ▼
API valida credenciales → MongoDB identity_db.users
   │ crea sesión → identity_db.sessions
   ▼
Set-Cookie: lumia_access (10m) + lumia_refresh (7d)
   │
   ▼
Requests con credentials → JWT validado + sesión activa
   │
   ▼ POST /api/auth/refresh
Rotación refresh token (revoca anterior, emite nuevo par)
```

### Flujo HTTP

```
Browser → Cloudflare → Tunnel → Fastify
   → Helmet + CORS + Rate Limit
   → Auth middleware (si aplica)
   → Controller/Service
   → Repository → MongoDB (catalog/sales/identity)
   → JSON response + X-Request-ID
```

---

## Documentación

| Documento | Contenido |
|-----------|-----------|
| [docs/README.md](docs/README.md) | Índice de documentación |
| [docs/roadmap.md](docs/roadmap.md) | Estado de fases y pendientes |
| [docs/cloudflare-tunnel.md](docs/cloudflare-tunnel.md) | Cloudflare Tunnel paso a paso |

### Estado de fases (resumen)

Detalle en [docs/roadmap.md](docs/roadmap.md):

| Fase | Contenido | Estado |
|------|-----------|--------|
| 1 | Núcleo (auth, catálogo, pedidos, Docker) | ✅ |
| 2 | Carrito, checkout, pago manual, expiración órdenes | ✅ |
| 3 | Tienda pública (store, favoritos, feedback, promociones) | ✅ |
| 4 | Panel admin (productos, pedidos, pricing, cost-summary, usuarios) | ✅ MVP+ |
| 5 | Producción y costeo (materiales, recetas, aprobaciones, impacto) | ✅ MVP+ |
| 6 | Google OAuth, 2FA, RBAC enterprise | ✅ MVP+ |
| 7 | Observabilidad, cron jobs, backups automáticos | 📋 Pendiente |
| 8 | Escalabilidad (Swarm, K8s, colas) | 📋 Futuro |

---

## Licencia

Privado — uso interno del proyecto.

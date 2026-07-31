# Panel Admin API — Fase 4

**Estado:** 📋 Planificado  
**Roadmap:** [../roadmap.md](../roadmap.md#fase-4--panel-admin-api)

---

## Objetivo

Exponer ~200 endpoints administrativos del monolito lumia como API independiente, protegidos por RBAC.

---

## Estrategia incremental

| Sprint | Módulo | Endpoints aprox. |
|--------|--------|------------------|
| 4.1 | Dashboard + analytics | ~15 |
| 4.2 | Productos admin (CRUD, variantes, opciones) | ~40 |
| 4.3 | Categorías, promociones, banners | ~25 |
| 4.4 | Pedidos admin | ~20 |
| 4.5 | Inventario | ~5 |
| 4.6 | Store settings admin | ~10 |
| 4.7 | Staff users | ~10 |
| 4.8 | Registry sync | ~5 |

RBAC enterprise (~80 endpoints) → evaluar en Fase 6.

---

## Autorización

### En lumia (actual)

`defineServiceApi` → consulta colección `services` en `identity_db`:

```javascript
{ key, httpMethod, endpoint, permissionKey, moduleKey }
```

### Recomendación para lumia-api

**Mapa estático** en código + tests:

```typescript
// src/modules/admin/config/route-permissions.ts
export const ADMIN_ROUTE_PERMISSIONS = [
  { method: 'GET', pattern: '/api/admin/products', permission: 'products.read' },
  { method: 'POST', pattern: '/api/admin/products', permission: 'products.create' },
  // ...
]
```

Opcional: sync desde Mongo para compatibilidad con seeds existentes.

---

## Permisos

Fuente tipada ya portada: `src/common/permissions/registry.ts`  
Seeds lumia: `server/database/seed/permissions.seed.ts`

---

## Estructura de carpetas futura

```
src/modules/admin/
  routes/
    dashboard.routes.ts
    products.routes.ts
    orders.routes.ts
  services/
  middleware/
    require-admin-permission.ts
  config/
    route-permissions.ts
```

---

## Compatibilidad

- Prefijo: `/api/admin/*`
- Respuestas paginadas idénticas a lumia
- Validación Zod en boundary HTTP (portar schemas de `shared/`)

---

## Qué evitar

- Bootstrap que resetea roles sistema en cada deploy
- Portar endpoints debug sin flag `NODE_ENV=development`

---

## Referencia lumia

```
server/api/admin/**/*.ts
server/database/seed/services.seed.ts  # catálogo completo de rutas
shared/permission-registry.ts
```

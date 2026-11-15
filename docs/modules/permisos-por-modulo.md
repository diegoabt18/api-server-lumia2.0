# Permisos por módulo (2026-11)

**Origen:** la auditoría de viabilidad de la IA (`AUDITORIA_VIABILIDAD_IA_LUMIA_ADMIN.md`, sección C) detectó varios módulos que reutilizaban permisos ajenos. El caso más grave: cualquier usuario con `admin.access` podía cambiar los ajustes de pagos y envíos.

## Permisos nuevos

| Permiso | Rutas |
|---|---|
| `store.settings.read` | `GET /admin/store-{shipping,currency,customer,payment}-settings` |
| `store.settings.manage` | `PUT/POST /admin/store-shipping-settings[/reset]`, `PATCH /admin/store-{currency,customer}-settings` |
| `store.payments.manage` | `PATCH /admin/store-payment-settings` |
| `promotions.read/create/update/delete` | `/admin/promotions*` (pausar y reanudar = `update`) |
| `banners.read/create/update/delete` | `/admin/store-banners*` |
| `feedback.read` / `feedback.moderate` | `GET /admin/feedback/reports` / `PATCH /admin/feedback/{reviews,questions}/:id` |
| `inventory.read` / `inventory.update` | `/admin/inventory*` y `PUT /admin/products/:id/inventory/:sku` |

**Qué se mantiene:**
- `adminGuard` sigue exigiendo `admin.access` más el permiso concreto.
- Los permisos antiguos no se eliminan: `products.*` sigue protegiendo productos y variantes.
- La prueba `tests/unit/module-permissions.test.ts` fija el permiso de cada una de estas rutas.

**Lumi usa los mismos permisos:**
- El stock y las iniciativas de stock exigen `inventory.read`.
- La búsqueda de productos solo muestra existencias con `inventory.read`.

## Despliegue sin pérdida de acceso

1. **Desplegar el Server.**
2. **Sincronizar el catálogo:** `POST /api/admin/security/permissions/sync`. Solo inserta lo que falta.
3. **Simular la migración:** `npm run db:migrate-module-permissions`. No escribe nada.
4. **Aplicar la migración**, con una de estas dos opciones (decisión del dueño):
   - `npm run db:migrate-module-permissions -- --apply --admin-access=preserve`: conserva el acceso actual.
   - `npm run db:migrate-module-permissions -- --apply --admin-access=skip`: no concede ajustes, pagos ni moderación a quien solo tenía `admin.access`.

**Qué hace la migración:**
- Añade permisos con `$addToSet` a las listas `permissionKeys` de `roles`, `permission_templates`, `temporal_permissions`, `user_permission_overrides` y `conditional_permissions`.
- Nunca quita nada y es idempotente.
- Las listas con `*` no se tocan.

**Limitación:** los cambios programados o pendientes de aprobación (`scheduled_changes`, `approval_requests`) creados antes de la migración no se reescriben. Hay que revisarlos a mano si contienen `products.*` o `admin.access`.

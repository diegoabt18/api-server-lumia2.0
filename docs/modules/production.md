# Producción y costeo — Fase 5

**Estado:** 🏗 Scaffolding (`src/modules/production/index.ts`)  
**Base de datos:** `production_db` (conexión activa desde Fase 1)  
**Roadmap:** [../roadmap.md](../roadmap.md#fase-5--producción-y-costeo)

---

## Objetivo

Portar el módulo de producción de lumia: materiales, recetas BOM, hojas de costo, aprobaciones de precio e integración con variantes de catálogo.

---

## Colecciones (19)

```
materials
material_price_history
suppliers
material_suppliers
recipes
recipe_versions
cost_sheets
cost_sheets_v2
production_config          # singleton global_production_config
labor_costs
production_costs
packaging_costs
service_costs
indirect_costs
price_approvals
cost_impacts
production_audit_log
unit_of_measures
unit_equivalences
```

Listado en código: `PRODUCTION_COLLECTIONS` en `src/modules/production/index.ts`.

---

## Integración con catálogo

| Campo | Ubicación | Uso |
|-------|-----------|-----|
| `production_recipe_id` | `catalog_db.variants` | Receta por SKU |
| `variant_cost_snapshots` | `catalog_db` | Snapshot costos |
| Pricing admin | cross-DB | calculate / simulate / suggest-margin |

---

## Endpoints lumia (~60)

Agrupados en:

- Materiales y proveedores
- Recetas y versiones
- Costeo (cost_sheets v1/v2)
- Aprobaciones de precio
- Conversión de unidades (utilidad pública)
- Auditoría producción

Ejemplo:

```
GET  /api/admin/materials
POST /api/admin/recipes
POST /api/admin/pricing/calculate
POST /api/admin/products/:id/cost-summary
GET  /api/production/unit-conversion/calculate-cost
```

---

## Lógica de negocio compartida

Portar desde lumia:

```
shared/production/costing.ts
server/core/production/domain/*.entity.ts
server/core/production/application/*
server/core/production/infrastructure/mongodb.*
```

---

## Endpoint diagnóstico actual

```
GET /api/production/status
```

Retorna `{ status: 'scaffolded', collections: [...] }` — no implementa negocio.

---

## Criterios de aceptación

- [ ] CRUD materiales con historial de precios
- [ ] Receta vinculada a variante por SKU
- [ ] Cálculo de costo coherente con lumia
- [ ] `production_audit_log` en cambios críticos
- [ ] Seeds: `unit_of_measures` (lumia bootstrap)

---

## Documentación lumia

```
docs/modules/production/database.md
docs/modules/production/README.md (si existe)
```

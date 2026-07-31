# Coupons / Promotions — Fase 3 (planificado)

**Estado:** 📋 Sin implementar  
**Documentación:** [docs/modules/store-public.md](../../docs/modules/store-public.md)

Motor de promociones en `catalog_db.promotions`.

Lógica lumia a portar:

```
server/core/pricing/promotion-resolution.ts
server/core/catalog/infrastructure/mongodb.promotion.repository.ts
```

Integración en `GET /api/products` (descuentos por variante).

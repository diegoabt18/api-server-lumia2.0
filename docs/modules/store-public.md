# Tienda pública — Fase 3

**Estado:** 📋 Planificado  
**Roadmap:** [../roadmap.md](../roadmap.md#fase-3--tienda-pública-completa)

---

## Objetivo

Paridad de API pública para que el frontend Nuxt en Cloudflare Pages funcione sin depender del backend Nitro embebido.

---

## Módulos por base de datos

### identity_db

| Feature | Colecciones | Endpoints |
|---------|-------------|-----------|
| Registro / perfil | `users` | `/api/auth/register`, `/api/auth/profile` |
| Preferencias cuenta | `users` | `/api/account/preferences` |
| Notificaciones | `notifications` | `/api/notifications/*` |
| Store settings | `store_shipping_settings`, `store_payment_settings`, `store_currency_settings`, `store_customer_front_settings` | `/api/store/*` |

### catalog_db

| Feature | Colecciones | Endpoints |
|---------|-------------|-----------|
| Banners | `store_banners` | `/api/store/banners` |
| Promociones | `promotions` | Resolución en GET `/api/products` |
| Feedback producto | — (sales) | `/api/products/:id/reviews`, questions |

### sales_db

| Feature | Colecciones | Endpoints |
|---------|-------------|-----------|
| Favoritos | `user_favorites` | `/api/account/favorites` |
| Reviews | `product_reviews`, `review_reactions` | feedback endpoints |
| Q&A | `product_questions`, `product_answers` | feedback endpoints |
| Pre-pedidos | `pre_orders` | flujo WhatsApp |

---

## Promociones (importante)

Portar lógica de lumia:

```
server/core/pricing/promotion-resolution.ts
server/core/catalog/infrastructure/mongodb.promotion.repository.ts
```

Respuesta producto debe incluir: `salePrice`, `promotionPercentOff`, `promotionEndsAt`, etc.

---

## Compatibilidad frontend

- Mismos nombres de campos JSON (camelCase en API)
- Paginación: `{ items, pagination: { page, limit, total, ... } }`
- Cookies cross-subdomain: `domain=.lumiadalistore.com`

---

## Carpetas futuras sugeridas

```
src/modules/
  store/          # store settings, banners
  promotions/     # motor descuentos
  notifications/
  customers/      # favoritos, preferencias (extiende users)
  feedback/       # reviews, questions
```

---

## Criterios de aceptación

- [ ] Catálogo con promociones activas
- [ ] Store settings desde Mongo (no env)
- [ ] Favoritos persisten por usuario
- [ ] Registro local opcional vía `AUTH_LOCAL_ENABLED`

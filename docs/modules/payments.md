# Módulo Payments — Fase 2

**Estado:** ✅ Pago manual implementado  
**Base de datos:** `sales_db`  
**Roadmap:** [../roadmap.md](../roadmap.md#fase-2--checkout-y-pagos)

---

## Objetivo

Gestionar pagos manuales (transferencia, depósito, etc.) en checkout: registro de intento, actualización de orden e inventario.

> Pasarela de pago online (MercadoPago u otras) **no forma parte del alcance** de este backend.

---

## Colecciones MongoDB

| Colección | Propósito |
|-----------|-----------|
| `payments` | Transacciones por orden |
| `orders` | Estado `paymentStatus`, TTL manual |

---

## Endpoints implementados

| Método | Ruta | Auth |
|--------|------|------|
| POST | `/api/payments/manual` | Opcional |

Relacionados en checkout/órdenes:

| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/api/orders/create` | Checkout con carrito |
| POST | `/api/orders/:id/cancel` | Cancelación |
| POST | `/api/orders/:id/cancel-request` | Solicitud de cancelación |
| GET | `/api/orders/list` | Mis pedidos |

---

## Job de expiración

Script CLI para órdenes impagas vencidas:

```powershell
npm run expire:orders
```

Variables:

```env
ORDER_PAYMENT_TTL_HOURS=24
ORDER_MANUAL_PAYMENT_TTL_HOURS=72
```

Programar en el host (Fase 7 — Task Scheduler / cron).

---

## Archivos en el server

```
src/modules/payments/
  services/manual-payment.service.ts
  infrastructure/payment.repository.ts
  domain/payment.types.ts
src/routes/payments.routes.ts
scripts/expire-orders.ts
```

---

## Consideraciones de diseño

1. **Cross-DB** — al confirmar pago manual, actualizar inventario en `catalog_db`
2. **TTL órdenes** — job `expire-orders` revierte stock si aplica
3. **Guest checkout** — pago manual acepta cookie de carrito invitado

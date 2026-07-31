# Módulo Payments — Fase 2

**Estado:** 🏗 Scaffolding (`src/modules/payments/index.ts`)  
**Base de datos:** `sales_db`  
**Roadmap:** [../roadmap.md](../roadmap.md#fase-2--checkout-y-pagos)

---

## Objetivo

Integrar MercadoPago para checkout completo: preferencia → pago → webhook → actualización de orden e inventario.

---

## Colecciones MongoDB

| Colección | Propósito |
|-----------|-----------|
| `payments` | Transacciones por orden |
| `payment_attempts` | Reintentos / idempotencia |
| `orders` | Estado `paymentStatus`, `mpPreferenceId`, `mpPaymentId` |

---

## Interface planificada

```typescript
interface PaymentProvider {
  createPreference(orderId: string, amount: number, currency: string): Promise<{
    preferenceId: string
    initPoint: string
  }>
  handleWebhook(payload: unknown, signature?: string): Promise<void>
}
```

Implementación: `MercadoPagoPaymentProvider` portada desde `lumia/server/core/payments/`.

---

## Endpoints a implementar

| Método | Ruta | Auth |
|--------|------|------|
| POST | `/api/payments/create-preference` | Sí |
| POST | `/api/payments/retry` | Sí |
| POST | `/api/payments/manual` | Sí |
| POST | `/api/mercadopago/webhook` | No (firma MP) |

---

## Archivos fuente en lumia

```
server/core/payments/domain/payment.entity.ts
server/core/payments/infrastructure/mercadopago.*
server/api/payments/create-preference.post.ts
server/api/payments/retry.post.ts
server/api/mercadopago/webhook.post.ts
```

---

## Variables de entorno

```env
MP_ACCESS_TOKEN=
MP_WEBHOOK_SECRET=
ORDER_PAYMENT_TTL_HOURS=24
ORDER_MANUAL_PAYMENT_TTL_HOURS=72
```

---

## Consideraciones de diseño

1. **Idempotencia webhook** — clave por `providerPaymentId`
2. **Cross-DB** — al aprobar pago, actualizar `catalog_db.inventory_items` con compensación si falla
3. **No portar Stripe** — código legacy en lumia; solo MP en producción
4. **TTL órdenes** — job cron `expire-orders` (Fase 7)

---

## Criterios de aceptación

- [ ] Preferencia MP creada desde orden pending
- [ ] Webhook `approved` marca orden como paid
- [ ] Webhook duplicado no duplica efectos
- [ ] Tests con payload MP mockeado

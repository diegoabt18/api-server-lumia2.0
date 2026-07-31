# Auth avanzada y RBAC enterprise — Fase 6

**Estado:** 📋 Planificado  
**Roadmap:** [../roadmap.md](../roadmap.md#fase-6--auth-avanzada-y-rbac-enterprise)

---

## Objetivo

Paridad opcional con el sistema de seguridad avanzado de lumia. **Implementar solo si hay uso real en producción.**

---

## Ya implementado (Fase 1)

- JWT access (10m) + refresh rotativo
- Sesiones en `identity_db.sessions`
- Cookies `lumia_access`, `lumia_refresh`
- RBAC por rol: `admin`, `moderator`, `user`
- `permHash` + `permissionsVersion` en JWT
- Detección reutilización refresh token (revoke family)

---

## Pendiente — OAuth

| Feature | lumia |
|---------|-------|
| Google OAuth 2.0 | `/api/auth/google/callback` |
| Provider local toggle | `AUTH_LOCAL_ENABLED` |

Variables:

```env
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
```

Flujo: redirect → callback → createSession (mismo que login local).

---

## Pendiente — 2FA TOTP

| Feature | Detalle |
|---------|---------|
| Librería | `otplib` |
| Storage | `users.twoFactor` embebido |
| Flujo | login → `requires2fa` + `tempToken` → `/api/auth/2fa/verify` |
| Alcance | Admins con 2FA activo |

Archivos lumia:

```
server/core/identity/infrastructure/mongodb.two-factor.repository.ts
server/utils/jwt-2fa.ts
server/api/auth/2fa/verify.post.ts
```

---

## Pendiente — RBAC enterprise

Colecciones `identity_db`:

```
roles, user_roles, permissions, modules, services
user_permission_overrides, temporal_permissions
role_delegations, scheduled_changes
approval_requests, permission_templates
conditional_permissions, permission_audit
webhooks, auth_audit_log
```

Endpoints lumia: ~80 bajo `/api/admin/security/*`

### Evaluación antes de portar

- [ ] ¿Se usan delegaciones en prod?
- [ ] ¿Hay flujos maker-checker activos?
- [ ] ¿Webhooks RBAC con consumidores?

Si **no** → mantener RBAC Fase 1 + roles en Mongo.

---

## Risk engine (lumia)

Campos en sesión: `riskScore`, `suspicious`, `lastCountry`  
Lógica: `server/utils/risk-engine.ts`, `session-anomaly.ts`

**Prioridad baja** — portar si hay incidentes de seguridad.

---

## CSRF

lumia: `assertSameOrigin` en mutaciones auth.  
lumia-api: CORS estricto + SameSite cookies. Evaluar Same-Origin check en Fase 6.

---

## Criterios de aceptación (mínimo viable Fase 6)

- [ ] Google OAuth funcional con frontend existente
- [ ] 2FA admin opcional
- [ ] Audit log login en `auth_audit_log`

Enterprise completo → solo bajo demanda explícita.

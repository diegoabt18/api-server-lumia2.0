# Infraestructura y comunicación del ecosistema

Verificado el 2026-11-14 (auditoría fase 2). Producción corre en el ThinkCentre; esta máquina de desarrollo no tiene `cloudflared`.

## Quién habla con quién

| Origen | Destino | Cómo | Autenticación | IP del cliente que ve la API |
|---|---|---|---|---|
| Navegador (tienda) | Worker Lumia 2.0 | HTTPS (lumiadalistore.com) | Cookies `lumia_access`/`lumia_refresh` (dominio de la tienda) | — |
| Worker Lumia 2.0 | API | `https://api.lumiadalistore.com` → Cloudflare → túnel | Cookies reenviadas | `X-Lumia-Client-IP` (= `CF-Connecting-IP`) con `X-Lumia-Proxy-Secret` |
| Cloudflare | API | `cloudflared` en el host → `http://localhost:3001` | — | `X-Forwarded-For` añadido por Cloudflare (con `TRUST_PROXY=loopback,uniquelocal`) |
| Navegador (admin) | Lumia Admin BFF | `http://127.0.0.1:3100` (solo loopback) | Cookies propias `lumia_admin_*` (HttpOnly, SameSite=Strict, Path=/api) | — |
| Lumia Admin BFF | API | Red Docker `server_lumia-network` → `http://server-api:3001` | Cookie `lumia_access` reconstruida por el BFF + `X-Lumia-Client: admin` | `X-Lumia-Client-IP` + secreto (o `X-Forwarded-For` desde la red Docker) |
| LumiChat (Android) | API | `https://api.lumiadalistore.com` (por defecto; configurable en la app) | `X-Lumi-Device-Key` | Cloudflare |
| API | local-ai-assistant | Red Docker `server_lumia-network`, sin puertos publicados | `X-API-Key` + `X-User-Ref` | — |
| local-ai-assistant | Ollama | Host (systemd), IP del puente de `server_lumia-network`:11434 | Ninguna (Ollama no autentica) | — |
| local-ai-assistant | SearXNG | Red `searxng_default` | Ninguna | — |
| local-ai-assistant | Redis | Solo para `/health/dependencies` | `REDIS_PASSWORD` opcional | — |
| API | MongoDB Atlas | TLS (`mongodb+srv`) | Usuario de base | — |
| API | Redis | Red Docker | `REDIS_URL` (con contraseña si `REDIS_PASSWORD`) | — |

Nadie usa el puerto 3001 desde la LAN: LumiChat y la tienda llegan por Cloudflare, el admin por la red Docker y `cloudflared` por `localhost`. Por eso la API se publica en `127.0.0.1` (`API_BIND_ADDRESS`).

## Variables de `docker compose` (server/.env, no versionado)

| Variable | Por defecto | Uso |
|---|---|---|
| `API_BIND_ADDRESS` | `127.0.0.1` | Interfaz donde se publica la API. `0.0.0.0` la expone sin Cloudflare. |
| `MONGO_ROOT_PASSWORD` | (ninguna) | Solo perfil `local`. Sin ella el contenedor Mongo no arranca. |
| `MONGO_EXPRESS_PASSWORD` | (ninguna) | Solo perfil `local`. |
| `REDIS_PASSWORD` | vacío | Activa `requirepass`; añadirla a `REDIS_URL` y al asistente. |

El contenedor `mongo` ya no se arranca en producción (perfil `local`): producción usa Atlas.

## Variables de la API relacionadas

`TRUST_PROXY` (por defecto `loopback,uniquelocal`), `EDGE_PROXY_SECRET` (≥ 32, el mismo en `NUXT_EDGE_PROXY_SECRET` del admin y en el *secret* del Worker), `ADMIN_AUDIT_SIGNING_KEY` (≥ 32, clave HMAC de la auditoría administrativa), `SWAGGER_ENABLED`.

## Pruebas del ecosistema

`npm run test:e2e` levanta Server, Lumia Admin BFF y local-ai-assistant reales contra un MongoDB desechable (ver `tests/e2e/global-setup.ts`):

```bash
docker run -d --rm --name lumia-e2e-mongo -p 127.0.0.1:27018:27017 mongo:7
npm run build && (cd ../lumia-admin && npm run build)
E2E_MONGO_URI=mongodb://127.0.0.1:27018 E2E_IA_PYTHON=python npm run test:e2e
```

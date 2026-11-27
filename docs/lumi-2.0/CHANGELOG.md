# Lumi 2.0 — Registro de cambios

## Fase 1.1 — Historial de conversaciones en el Server (2026-11-27)

Sin commits (pendiente de revisión). Parte de la Fase 1; faltan dispositivos móviles, WebSocket y
LumiChat.

### Cambios

| Repo | Archivos | Qué hace |
|---|---|---|
| local-ai-assistant | `app/schemas/chat.py`, `app/services/assistant_service.py`, `app/api/v1/chat.py` | `/chat` y `/chat/stream` aceptan `history` (máx. 50 turnos, roles user/assistant, 8 000 caracteres) y `persist=false`. Sin esos campos el comportamiento es el de siempre |
| local-ai-assistant | `scripts/export_conversations.py` | Exporta la SQLite a JSON en modo solo lectura (biblioteca estándar) |
| server | `src/modules/lumi/conversation/conversation.store.ts` | `lumi_conversations` y `lumi_messages` en `identity_db`: dueño, `seq` consecutivo atómico, reserva idempotente por `clientMessageId` (índice único) |
| server | `src/modules/lumi/conversation/conversation.service.ts` | Misma interfaz que el cliente de la IA Assistant (`chat`, `chatStream`, `recordExchange`, listar, ver, borrar). Envía el historial (12 turnos) con `persist=false` y guarda el turno solo al terminar |
| server | `src/routes/lumi.routes.ts`, `src/app.context.ts`, `src/modules/lumi/schemas/lumi.schema.ts`, `src/modules/lumi/infrastructure/lumi-assistant.client.ts` | Las rutas usan el servicio. `clientMessageId` opcional en el cuerpo del chat. Contratos con Lumia Admin sin cambios |
| server | `src/modules/lumi/conversation/conversation.migration.ts`, `scripts/migrate-lumi-conversations.ts` | Importación validada e idempotente del JSON, con simulación por defecto y verificación posterior |

Comportamiento nuevo: listar, ver y borrar conversaciones funcionan aunque la IA Assistant no esté
configurada; reintentar un mensaje con el mismo `clientMessageId` devuelve la respuesta guardada; si el
mismo mensaje se está respondiendo, 409 `LUMI_MESSAGE_IN_PROGRESS`.

### Pruebas

| Tipo | Resultado |
|---|---|
| Server, unitarias | 828 pasan. 1 falla: `lumi-tools` «reconocer una frase es inmediato» (límite 500 ms por 1 000 llamadas). En aislamiento tarda ~195 ms; falla solo por carga con la suite completa en paralelo. No se cambió su umbral |
| Server, nuevas | `lumi-conversations.test.ts` (12), `lumi-conversation-migration.test.ts` (3) |
| Server, integración MongoDB | `lumi-conversations.integration.test.ts` (5): **no ejecutada**, falta `MONGO_TEST_URI` (no se prueba contra producción) |
| IA Assistant | 200 pasan (5 de historial del Server + 2 del exportador) |
| Migración real | **No ejecutada**: requiere la SQLite del M720q y autorización para escribir en Atlas |

### Despliegue (orden)

1. IA Assistant primero (acepta `history`/`persist`; compatible con el Server actual).
2. Server después.
3. Migración: exportar en el contenedor de la IA Assistant, copiar el JSON, simular, `--apply`, borrar
   el JSON. Hasta migrar, las conversaciones antiguas no aparecen en el historial (siguen en la SQLite).

### Cómo revertir

Volver a desplegar la versión anterior del Server: el historial vuelve a leerse de la SQLite (que no se
modifica). Las colecciones nuevas pueden borrarse sin afectar a nada más.

## Fase 0.5 — Correcciones previas (2026-11-27)

Sin commits en `server` (pendiente de tu revisión). LumiChat: commit inicial `78245fb`.

### Cambios

| Tarea | Repo | Archivos | Resultado |
|---|---|---|---|
| Versionar LumiChat | lumichat | `.gitignore` (+ `.kotlin/`), `git init`, commit `78245fb` | 36 archivos; sin `google-services.json`, `local.properties` ni keystores |
| Redis obligatorio en producción | server | `src/config/env.ts` (`assertProductionRequirements`), `src/database/connections/redis.manager.ts`, `.env.example` | Con `NODE_ENV=production`, sin `REDIS_URL`/`REDIS_ENABLED=true` o sin conexión al arrancar, el servidor no arranca. Desarrollo y pruebas sin cambios |
| Notificaciones en tiempo real entre instancias | server | `src/modules/notifications/infrastructure/redis-notification-bus.ts` (nuevo), `services/notification-stream.hub.ts`, `src/app.context.ts` | El hub SSE publica por Redis pub/sub cuando hay Redis; si Redis falla al publicar, entrega en la instancia y lo registra |
| Quitar datos personales del push | server, lumichat | `src/modules/notifications/services/push.service.ts` (`preOrderPushData`), `lumichat/app/src/main/res/values/strings.xml` | El push de pedido nuevo ya no lleva nombre ni WhatsApp del cliente. En LumiChat el botón de WhatsApp queda desactivado con un aviso hasta la Fase 1 (decisión del usuario) |
| Retirar código de música muerto | server | `src/modules/lumi/infrastructure/lumi-assistant.client.ts`, `src/modules/lumi/tools/tool-adapters.ts` | Fuera los métodos `music*` (llamaban a endpoints eliminados en la IA Assistant, `c6825ab`) y las fábricas `createLumiMusicPort` / `readOnlyMusicPort`, que nadie llamaba |
| Reparar los 7 tests rotos | server | `tests/unit/lumi-capability-activation.test.ts`, `tests/unit/lumi-desktop-chat.test.ts` | Suponían las 20 herramientas `music.*` retiradas en `1cb2c97`. Ahora comprueban invariantes del catálogo actual en lugar de recuentos fijos |

### Pruebas

| Tipo | Comando | Resultado |
|---|---|---|
| Unitarias | `npx vitest run` | **814 / 814** (antes: 7 fallos) |
| Nuevas | `tests/unit/redis-required.test.ts`, `tests/unit/push-payload.test.ts` | 5 + 2 pasan |
| Integración con Redis real | `REDIS_TEST_URL=redis://… npm run test:integration` (`notification-bus.integration.test.ts`) | **No ejecutada**: no hay Redis ni Docker en el equipo de desarrollo |
| Tipos / lint | `npx tsc --noEmit`, `npx eslint` sobre los archivos tocados | Sin errores |
| LumiChat | — | **No compilado** (solo cambió un texto de `strings.xml`) |

### Pendiente

- Ejecutar la prueba de integración del bus con un Redis real (p. ej. el del M720q).
- Medir el M720q (comandos en [AUDIT.md](AUDIT.md) §13).
- Antes de desplegar: confirmar que el `.env.production` del M720q tiene `REDIS_ENABLED=true` y un
  `REDIS_URL` alcanzable; si no, el servidor nuevo **no arrancará**.
- El modo «mixto» del selector (catálogo de más de 40 herramientas) no se puede dar con el catálogo
  actual (27) y queda sin prueba; `routeSelectorMenu` no permite inyectar un catálogo.
- Siguen sin uso los tipos `LumiMusicPort`, `LumiMusicState` y el evento de chat `music`: se retiran
  cuando `tool.types.ts` y `lumi.routes.ts` no estén en edición en otra sesión.

### Cómo revertir

- server: `git checkout -- <archivo>` sobre los archivos listados y borrar los tres archivos nuevos
  (`redis-notification-bus.ts`, `redis-required.test.ts`, `push-payload.test.ts`,
  `notification-bus.integration.test.ts`). Sin migraciones ni cambios de datos.
- lumichat: `git revert` del cambio de `strings.xml` cuando se confirme; el commit `78245fb` solo
  añade historial.

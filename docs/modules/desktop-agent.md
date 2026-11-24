# Lumia Desktop Agent (fases 1 a 6)

Equipos de escritorio que ejecutan operaciones autorizadas por el Server. El agente (repositorio
`lumia-desktop-agent`) no contiene IA ni decide nada: el Server es la única autoridad. Contrato del
protocolo: `lumia-desktop-agent/docs/communication-protocol.md`.

Activación: `DESKTOP_AGENT_ENABLED=true`. Sin ella no se registra ninguna ruta. En producción es
obligatoria `DESKTOP_GRANT_SIGNING_KEY` (en desarrollo se usa una clave efímera y se avisa en el log).

## Piezas

| Pieza | Dónde |
|---|---|
| Protocolo 1.1 (sobre, cargas, tareas, cadenas firmadas, códigos de cierre) | `src/modules/lumi/desktop-agent/domain/protocol.ts` |
| Equipos, códigos de inscripción, verificación Ed25519 | `domain/device.ts` |
| Catálogo de operaciones (permiso, esquema estricto, resumen sin datos privados) | `domain/operations.ts` |
| Persistencia (identity_db): `desktop_devices`, `desktop_enrollments` (TTL), `desktop_registrations` (TTL) | `infrastructure/desktop-device.repository.ts` |
| Registro de ejecuciones `desktop_executions` (TTL 180 días) | `infrastructure/desktop-execution.repository.ts` |
| Firma de grants (JWS EdDSA) | `infrastructure/grant-signer.ts` |
| Alta en dos pasos con prueba de posesión de la clave | `services/enrollment.service.ts` |
| Pasarela WebSocket (desafío, latido, estado, capacidades, tareas, revocación) | `services/desktop-gateway.ts` |
| Despacho, seguimiento, resultados, cancelación, reenvío y vigilancia | `services/execution.service.ts` |
| Rutas | `src/routes/lumi-desktop-agent.routes.ts` |
| Aprobaciones «no volver a preguntar» (`desktop_approvals`, tipo + destino por equipo) | `infrastructure/desktop-approval.repository.ts` |
| Puerto para Lumi Chat (equipos, ejecutar, aprobaciones, acciones pendientes) | `services/lumi-desktop-port.ts` |
| Herramientas `device.*` de Lumi, reglas y confirmaciones | `src/modules/lumi/tools/desktop.tools.ts` |
| Selección en dos niveles (grupos tienda / música / equipo) | `src/modules/lumi/selector/tool-groups.ts` |
| Servidor de desarrollo en memoria (sin Mongo) con escenarios `browser`, `desktop` y `chat` | `scripts/desktop-agent-dev-server.ts` |
| Banco del selector (antes / dos niveles / flujo completo) | `scripts/selector-routing-bench.ts` |
| Transferencias de archivos (retransmite bloques, no guarda) | `services/transfer.service.ts` |
| Vista previa de Lumia Admin en memoria (sesión ficticia, rutas reales de gestión, chat mínimo del equipo) | `scripts/desktop-admin-preview-server.ts` |

## Endpoints

| Método | Ruta | Autenticación | Descripción |
|---|---|---|---|
| POST | `/api/desktop-agent/registrations/start` | Código de inscripción (10/min por IP) | Código + clave pública → desafío de 60 s |
| POST | `/api/desktop-agent/registrations/complete` | Firma del desafío (10/min por IP) | Consume el código y crea el equipo |
| GET (WS) | `/api/desktop-agent/ws` | Desafío firmado con la clave del equipo (30/min por IP) | Sesión persistente del agente |
| GET | `/api/admin/desktop/devices` | `admin.access` + `desktop.devices.read` | Equipos **propios** con `online` |
| GET | `/api/admin/desktop/devices/:id` | `admin.access` + `desktop.devices.read` | Un equipo propio (404 si es de otra persona) |
| POST | `/api/admin/desktop/enrollments` | `admin.access` + `desktop.devices.manage` | Código de un solo uso (10 min), propietario = quien lo genera |
| PATCH | `/api/admin/desktop/devices/:id` | `admin.access` + `desktop.devices.manage` | Renombrar `{ name }` |
| POST | `/api/admin/desktop/devices/:id/revoke` | `admin.access` + `desktop.devices.manage` | Revoca y desconecta al agente (`device.revoked`, 4403) |
| POST | `/api/admin/desktop/devices/:id/executions` | `admin.access` + permiso de la operación (30/min) | `{ operation, arguments, timeout_ms? }` → espera el resultado verificado y lo devuelve |
| GET | `/api/admin/desktop/devices/:id/executions` | `admin.access` + `desktop.devices.read` | Historial (solo metadatos) |
| POST | `/api/admin/desktop/executions/:id/cancel` | `admin.access` + permiso de la operación | Envía `task.cancel`; solo quien la ordenó |
| GET | `/api/admin/desktop/approvals` | `admin.access` + `desktop.devices.read` | Aprobaciones propias (tipo + destino + equipo) |
| GET | `/api/admin/desktop/devices/:id/files/roots` | `admin.access` + `desktop.files.read` | Carpetas autorizadas en el equipo (id y nombre) |
| GET | `/api/admin/desktop/devices/:id/files?root&path` | `admin.access` + `desktop.files.read` (60/min) | Hasta 500 entradas de una carpeta |
| GET | `/api/admin/desktop/devices/:id/files/download?root&path` | `admin.access` + `desktop.files.read` (20/min) | Archivo en streaming (`X-Content-SHA256`), ≤ 100 MB |
| POST | `/api/admin/desktop/devices/:id/files/upload?root&dir&name&size&sha256` | `admin.access` + `desktop.files.write` (10/min) | Cuerpo `application/octet-stream`; nunca reemplaza un archivo |
| DELETE | `/api/admin/desktop/approvals/:id` | `admin.access` + `desktop.devices.read` | Retira una aprobación propia (404 si no es suya) |

## Operaciones

| Operación | Permiso | Argumentos |
|---|---|---|
| `browser.discover` | `desktop.browser.read` | — |
| `browser.snapshot` | `desktop.browser.read` | `interactive?` |
| `browser.tabs.list` | `desktop.browser.read` | — |
| `browser.navigate` | `desktop.browser.control` | `url` (solo http/https, sin credenciales, ≤ 2048) |
| `browser.click` | `desktop.browser.control` | `ref` (`e<número>` de un snapshot) |
| `browser.fill` | `desktop.browser.control` | `ref`, `value` (≤ 10 000) |
| `browser.scroll` | `desktop.browser.control` | `direction`, `pixels?` (1–10 000) |
| `browser.close_session` | `desktop.browser.control` | — |
| `desktop.status` | `desktop.apps.read` | — |
| `desktop.list_applications` | `desktop.apps.read` | — |
| `desktop.list_windows` | `desktop.apps.read` | — (devuelve títulos de ventanas: dato privado) |
| `desktop.snapshot` | `desktop.apps.read` | `app`, `window_id?`, `interactive?`, `skeleton?`, `root?` |
| `desktop.get_value` | `desktop.apps.read` | `ref` (`@<snapshot>:e<número>`) |
| `desktop.click` | `desktop.apps.control` | `ref` |
| `desktop.set_value` | `desktop.apps.control` | `ref`, `value` (≤ 10 000) |
| `desktop.press_key` | `desktop.apps.control` | `app`, `key` (solo navegación y edición: `DESKTOP_ALLOWED_KEYS`) |

No existe ninguna operación de shell, de JavaScript arbitrario, de cookies, de almacenamiento, de
coordenadas, de portapapeles, de capturas ni para lanzar o cerrar aplicaciones. Además, el agente
aplica una política local que el Server no puede ampliar: nunca automatiza terminales, editores con
terminal, herramientas del sistema, navegadores (solo su perfil aislado), gestores de contraseñas,
acceso remoto ni a sí mismo (`APPLICATION_BLOCKED`, ejecución `rejected`).

## Autorización de una ejecución (en este orden)

1. Operación del catálogo y argumentos que cumplen el esquema estricto (400).
2. Permiso de quien la pide (403).
3. El equipo es suyo (404 si no; el comodín `*` no da acceso a equipos ajenos), activo (409
   `DEVICE_REVOKED`), conectado (409 `DEVICE_OFFLINE`), sin pausa local (409 `DEVICE_PAUSED`) y anuncia
   la operación en su `capability.report` (409 `OPERATION_NOT_SUPPORTED`).
4. Se firma un grant de 120 s para ese equipo (`aud`), tarea (`task_id`), usuario (`sub`), operación
   y argumentos, con un `jti` único. El agente ejecuta los argumentos **del grant**.

## Registro y privacidad

`desktop_executions` guarda usuario, equipo, operación, `authorizationId` (`jti`), resumen de
argumentos, estados, verificación, error y duración. No guarda resultados (pueden contener contenido
de páginas o ventanas), ni la ruta o la query de las URL (solo el origen), ni lo escrito en campos o
aplicaciones (solo su longitud). Por eso la ruta de despacho está excluida de la auditoría administrativa genérica, que
guardaría el cuerpo de la petición. El resultado solo viaja en la respuesta HTTP.

## Fiabilidad

- Despacho no entregado (el agente se desconectó antes de `received`): se reenvía con el mismo grant
  al reconectar; si el grant venció, la ejecución termina `failed` / `DELIVERY_EXPIRED`.
- Sin resultado en `timeout + 15 s`: `timed_out`. Un resultado tardío no cambia nada.
- Cada `task.result` se confirma con `task.result.ack`; el agente reenvía los no confirmados.
- Un equipo no puede informar de tareas de otro (se ignora y se registra un aviso).

## Lumi Chat (fase 4)

Nueve herramientas `device.*` (módulo `equipo`, externas: su texto no vuelve al modelo): estado,
abrir / leer / pulsar / escribir en la página, ventanas abiertas, leer / pulsar / escribir en una
aplicación. Detalle y mediciones: `lumia-desktop-agent/docs/phase-4-lumi.md`.

- Cada acción de control pide confirmación salvo aprobación previa de **tipo + destino** (host o
  aplicación) en ese equipo. «sí» la ejecuta una vez; «sí, no vuelvas a preguntar» la ejecuta y la
  recuerda; «no» no hace nada ni guarda nada. Acción pendiente: 10 min (`desktop_action`).
- `commandReply` en `lumi.routes.ts` atiende esas respuestas (`handleDesktopReply`) antes que los
  demás comandos, en `/admin/lumi/chat` y `/chat/stream`.
- Las aprobaciones no saltan permisos: cada operación vuelve a pasar RBAC y lleva su propio grant.
  Revocar un equipo borra sus aprobaciones.
- Órdenes claras (abrir URL, pulsar, escribir en un campo, leer botones de una app, estado,
  ventanas) se resuelven por reglas sin modelo; el texto a escribir sale del mensaje original.
- Selección en dos niveles: si las palabras clave señalan un solo grupo se envía solo ese menú;
  si todo cabe en 40 herramientas, el menú completo; si no, tienda + `grupo.musica` / `grupo.equipo`
  y una segunda llamada solo si el modelo elige un grupo. La traza guarda `selector.routing`.

### Lumia Admin (fase 5)

- Cuando una acción espera respuesta, el stream del chat emite el evento SSE `confirmation`
  `{ id, summary, device, scope, expiresAt }`. Lumia Admin lo muestra como tarjeta con «Sí» / «No»
  y la casilla «No volver a preguntar para <scope> en este equipo» (solo cuenta para el «sí»).
- Los botones envían el mismo texto que se podría escribir más `confirmationId` (24 hex) en el
  cuerpo del chat. Con identificador, `PendingActionStore.take` solo consume esa acción: una tarjeta
  antigua, ya respondida o caducada responde «Esa confirmación ya no está vigente; no hice nada.» y
  no toca la acción más reciente. Escribir «sí» sin identificador sigue funcionando como antes.
- `registerDesktopAgentAdminRoutes(api, guards, deps)` recibe las guardas (`desktopAdminGuards(ctx)`
  en producción) para poder montar las rutas reales en la vista previa sin MongoDB.

## Archivos (fase 6)

- El usuario autoriza carpetas en la ventana local del agente; el Server solo conoce su id
  (`root_<12 hex>`) y su nombre, nunca la ruta completa, y no puede añadir ninguna.
- `files.roots` y `files.list` son operaciones normales. `files.download` y `files.upload` abren un
  canal `transfer.*` (protocolo 1.2) y pueden durar hasta 15 min.
- El Server no guarda archivos: pide o envía bloques de 256 KiB de uno en uno, calcula el SHA-256
  de lo que pasa y solo hace `commit` si coincide. En la subida, tamaño y SHA-256 van en el grant.
- El registro de ejecuciones guarda solo la carpeta, la extensión y el tamaño: nunca el nombre ni la
  ruta del archivo. Las rutas `/files` están fuera del registro de actividad (el cuerpo es el archivo).
- Detalle: `lumia-desktop-agent/docs/phase-6-files.md`.

## Pruebas

- `tests/unit/desktop-agent.test.ts`: alta, pasarela, HTTP + WebSocket reales y contrato con los
  ejemplos del agente (`protocol/examples`).
- `tests/unit/desktop-agent-execution.test.ts`: autorización, firma del grant, ciclo de vida,
  privacidad del registro, cancelación, vigilancia y reenvíos.
- Extremo a extremo con el agente y un navegador reales: `npx tsx scripts/desktop-agent-dev-server.ts
  --scenario browser|desktop|chat` y el runner del agente (ver `lumia-desktop-agent/README.md`).
- `tests/unit/desktop-agent-transfer.test.ts`: relé de descarga y subida con un agente simulado
  (orden de bloques, SHA-256, tamaños, permisos, rutas con `..`, desconexión).
- `tests/unit/lumi-desktop-chat.test.ts`: enrutado en dos niveles, confirmaciones, aprobaciones y
  reglas de las herramientas `device.*`.
- `scripts/selector-routing-bench.ts`: compara el selector real del asistente antes y después.
- Vista previa en el navegador (solo local): `npx tsx scripts/desktop-admin-preview-server.ts` y
  Lumia Admin con `NUXT_API_BASE_URL=http://127.0.0.1:3941 npm run dev`; cualquier correo y
  contraseña entran como `preview-user`. No usa datos reales.

## Pendiente

Producción: firma, instaladores, actualizaciones (fase 7). HTTPS en la red local. Varias
instancias del Server necesitarían enrutar por Redis (hoy las conexiones viven en memoria de una
instancia). El estado en línea en Lumia Admin se consulta cada 10 s; no hay eventos de dispositivos.

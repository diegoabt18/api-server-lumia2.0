# Lumi — catálogo de herramientas y reglas seguras (Fase 3)

Lumi responde con **datos reales** de Lumia sin usar el modelo cuando la pregunta es una consulta
reconocible. El modelo solo interviene para conversación libre o para explicar datos que el Server
ya leyó.

## Orden de decisión de un turno

1. **Comandos de automatización** (`automation/domain/reminder-parser.ts`): recordatorios, rutinas,
   pausar, reanudar, borrar. Sin modelo.
   - Las frases sobre datos de la tienda (pedidos, productos, ventas…) **no** son órdenes de rutina
     salvo que nombren explícitamente «rutina», «recordatorio» o «revisión diaria».
   - **Borrar exige confirmación**: Lumi describe qué borrará y guarda una acción pendiente
     (`lumi_pending_actions`, caduca a los 10 min). Solo «sí, elimínala» la ejecuta, y después se
     comprueba que la rutina ya no existe. «No» la descarta.
2. **Catálogo de herramientas** (`tools/catalog.ts`): consultas de solo lectura reconocidas por reglas.
   Sin modelo: la respuesta es texto determinista.
3. **Explicación de datos**: si la frase pide explicar («¿por qué…?», «analiza…») y una herramienta
   la reconoce, la herramienta lee los datos y el modelo los recibe como contexto rotulado como datos.
4. **Modelo**: el resto. Recibe un **texto de capacidades** generado por el Server según los permisos
   del usuario (fecha de hoy, qué puede pedir y con qué frases, y la regla de no afirmar acciones).

## Herramientas

| Herramienta | Permiso | Ejemplo |
|---|---|---|
| `orders.lookup` | `orders.read` | «¿Cómo va el pedido ORD-CB07203E?» |
| `orders.count` | `orders.read` | «¿Cuántos pedidos tengo por despachar?», «¿Cuántos pedidos hubo en los últimos 30 días?» |
| `orders.recent` | `orders.read` | «Muéstrame los últimos 5 pedidos» |
| `sales.summary` | `analytics.read` | «¿Cuánto vendimos esta semana?», «productos más vendidos este mes» |
| `products.search` | `products.read` (las existencias solo se muestran con `inventory.read`) | «¿Cuánto stock queda de la vela ambar?» |
| `inventory.low` | `inventory.read` | «¿Qué productos se están agotando?» |
| `initiatives.list` | `lumi.use` (y el permiso de cada tipo) | «¿Qué iniciativas urgentes tengo?» |
| `notifications.unread` | `lumi.use` | «¿Tengo notificaciones sin leer?» |

Garantías:

- **Permisos:** se comprueban en el Server antes de leer nada. Sin permiso, la respuesta es un aviso
  y no se consulta la base.
- **Datos de clientes:** nunca se devuelven nombre, correo, teléfono ni dirección. La búsqueda de
  pedidos es solo por referencia o número, nunca por cliente.
- **Límites:** las filas y el texto están acotados (`TOOL_TEXT_MAX_CHARS`).
- **Fechas:** los periodos («hoy», «esta semana», «mes pasado», «últimos N días») los calcula el
  Server en la zona `America/Bogota`. El modelo nunca calcula fechas ni cifras.
- **Indicador en el chat:** el stream SSE emite `tool {name,label,rows,denied}` y el chat muestra
  la etiqueta «Datos de Lumia · N resultados».

## Iniciativas y permisos

- **Qué se genera:** cada tipo de iniciativa exige un permiso (`INITIATIVE_KIND_PERMISSION`):
  `stock` → `inventory.read`, `order_attention` → `orders.read`; `routine_failed` es del propio
  usuario. El motor solo genera y notifica los tipos permitidos. Sin `lumi.use` no genera nada.
- **Qué se ve:** el listado y los cambios de estado ocultan los tipos sin permiso.
- **Lecturas truncadas:** si una lectura llega al límite de filas (200), ese tipo se marca como
  truncado y no se completa ninguna iniciativa de él en esa pasada. Así se evitan cierres falsos y
  reaperturas en bucle.

## Búsqueda de productos

`products.search` usa la **búsqueda común** del Server:
- **Constructor de filtros:** `src/modules/catalog/domain/product-search.ts`, compartido con la tienda, el panel y el POS.
- **Consulta paginada:** `ProductRepository.searchProducts`, que devuelve id, slug, estado, disponibilidad y precios.

| Modo | Comportamiento |
|---|---|
| `contains` | Cada palabra en cualquier orden |
| `exact` | El nombre o el slug completos |

En ambos modos no se distinguen tildes ni mayúsculas, y el texto del usuario se escapa: nunca se interpreta como expresión regular. No hay relevancia ni búsqueda semántica (requieren un índice de texto o embeddings; pendiente de aprobación).

## Añadir una herramienta

1. Definir `LumiTool` en `catalog.ts`: nombre, etiqueta, capacidad, ejemplo, permiso, `match`
   (regla sobre texto normalizado) y `run` (lectura acotada y texto por plantilla).
   Para que el selector (etapa 2) pueda elegirla, añadir `selector`: descripción, módulo,
   argumentos y `fromArgs` (construye la entrada; los valores cerrados salen del mensaje).
2. Si necesita datos nuevos, añadir el puerto en `tool.types.ts` y el adaptador en `tool-adapters.ts`.
3. Añadir pruebas:
   - frases positivas y negativas en `tests/unit/lumi-tools.test.ts`;
   - la consulta real en `tests/integration/lumi-tools.integration.test.ts`;
   - si cambia el flujo, el E2E.

## Selector con Qwen (etapa 2, fase A2)

Las reglas (`match`) siguen resolviendo primero, sin modelo. Si ninguna reconoce el mensaje y
`LUMI_SELECTOR_ENABLED=true`, el Server pide a ia-asistente (`POST /api/v1/select`) una propuesta:

```json
{"status": "tool|chat|missing|ambiguous", "intents": [{"tool": "...", "args": {}}], "need": "", "module": "pedidos"}
```

El modelo solo **propone**. El Server (`src/modules/lumi/selector/lumi-selector.ts`):

1. descarta herramientas y argumentos que no existen;
2. exige que los textos (búsqueda, referencia) aparezcan en el mensaje o en la entidad activa;
3. toma la referencia del mensaje (`ORD-…`) o de la entidad activa;
4. construye la entrada con `fromArgs` (periodos y estados salen del mensaje);
5. comprueba el permiso (sin permiso no lee nada);
6. decide el estado final.

| Estado | Respuesta |
|---|---|
| `supported` | Ejecuta una o dos herramientas (texto determinista) |
| `missing_information` | Pregunta solo el dato que falta (`selector.ask`) |
| `missing_capability` | «Todavía no tengo una herramienta para…». No usa una herramienta parecida. La fase B la registrará |
| `ambiguous` | Pide más detalle |
| `delegated` | Clima e internet van al chat con búsqueda web (si hay `lumi.web`); recordatorios, a la pista de uso |
| `unsupported` | Conversación normal con el modelo |

- El catálogo enviado incluye **todas** las herramientas, también las que el usuario no puede usar: así una consulta sin permiso responde «no tienes permiso» en lugar de registrarse como capacidad que falta.
- Si ia-asistente no responde en `LUMI_SELECTOR_TIMEOUT_MS`, el turno sigue como conversación.
- Los registros guardan el estado, las herramientas, la latencia y los tokens, **nunca el texto del usuario**.

### Entidad activa (Context Manager)

`lumi_context` (identity_db) guarda por usuario y conversación la última entidad de una respuesta
(un pedido o un producto) durante 30 minutos (índice TTL). La entidad abierta en pantalla tiene
prioridad. Solo se guarda la referencia visible (nunca datos de clientes), y cada uso vuelve a pasar
por el permiso de la herramienta.

La especificación medida de estas reglas está en `local-ai-assistant/bench/rules.py`.

## Capability Manager (fase B)

Cuando el selector decide `missing_capability`, el Server registra la petición en
`lumi_capabilities` y `lumi_capability_requests` (identity_db) y responde con una plantilla, sin
modelo. Solo dice «He registrado la petición» si el registro funcionó.

- **Agrupación** (`capabilities/domain/capability-signature.ts`): palabras clave de `need` y del
  mensaje, sin palabras vacías ni verbos de petición, con sinónimos y raíz de 5 letras.
  - Mismas palabras, Jaccard ≥ 0,6, o una contiene a la otra con dos palabras en común: **la misma**
    capacidad (contador y frase de ejemplo).
  - Coincidencia parcial: capacidad nueva con `possibleDuplicateOf`. Fusionar lo decide un
    administrador.
  - Compartir solo modificadores («sin», «exportar», «usuario») no agrupa.
  - Una petición igual a una capacidad fusionada se suma a la que la absorbió.
- **Repetición:** la misma persona con la misma firma solo cuenta una vez cada 10 minutos.
- **Límites:** frase de 500 caracteres, `need` de 120, 5 frases de ejemplo y 50 entradas de historial.

| Ruta (`/api/admin/lumi/capabilities`) | Permiso |
|---|---|
| `GET /` (filtros `status`, `module`, `priority`, `search`; orden `recent`, `requests`, `created`; paginada) · `GET /stats` · `GET /:id` | `lumi.capabilities.read` |
| `PATCH /:id` (título, descripción, módulo, prioridad, especificación) · `POST /:id/status` · `POST /:id/merge` | `lumi.capabilities.manage` |

- El detalle muestra las últimas frases **sin su autor** y el número de usuarios distintos.
- Transiciones manuales: `detected → pending_review → approved → in_development → ready_for_testing`,
  más `rejected` y su reapertura. `testing`, `validated`, `enabled` y `disabled` no se pueden
  poner a mano: llegan con las fases D y E. `duplicate` solo llega por fusión.
- Los cambios quedan en el historial de la capacidad y en la auditoría de actividad administrativa
  (sin las frases de los usuarios).
- Los dos permisos son nuevos y no se conceden a nadie automáticamente: solo los tienen los roles
  con `*` hasta que se asignen.

## Probar capacidad (fase D)

El plan de un turno vive en `modules/lumi/turn/turn-plan.ts` (`planLumiTurn`): reglas → selector →
Server, **sin efectos**. Lo usan el chat (que añade el registro de la capacidad que falta y las
métricas) y el entorno de pruebas, así que lo que se prueba es lo que hace el chat.

**Entorno de pruebas** (`capabilities/services/sandbox-runner.ts`):
- recorre el mismo plan con los permisos de quien prueba;
- los recordatorios solo se detectan (`parseAutomationCommand`), no se crean;
- solo ejecuta herramientas del catálogo, todas de lectura. Sin permiso no lee datos;
- no llama a la conversación del modelo, no registra capacidades, no guarda historial ni entidad activa;
- sin contexto de pantalla ni de conversación: la frase se prueba sola;
- `forceSelector` usa el selector aunque `LUMI_SELECTOR_ENABLED=false`, para evaluarlo antes de activarlo. Si el asistente no está configurado, responde 409.

**Frases** (`lumi_capability_phrases`, máx. 30 por capacidad): texto, rol, resultado esperado
(`supported`, `missing_information`, `missing_capability`, `ambiguous`, `delegated` o `unsupported`),
herramienta esperada opcional (solo con `supported` o `missing_information`) y si es crítica.
- `test`: entra en la batería.
- `validation`: entra en la batería y decide si la capacidad pasa.
- `control`: **nunca** se ejecuta aquí; solo lo usa el banco de medición.

**Ejecuciones** (`lumi_capability_test_runs`, TTL de 90 días):
- corren en segundo plano: `POST` responde 202 y el panel consulta la ejecución;
- una sola en curso por capacidad; tras 30 minutos se da por interrumpida;
- por frase se guardan la etapa, la propuesta del modelo y la decisión del Server, la latencia y los tokens, la entrada validada, las herramientas ejecutadas (filas, tiempo y texto recortado a 300 caracteres) y si acertó.

**Batería y estado:**
- **Pasa** con ≥ 90 % en validación y el 100 % de las frases críticas.
- Si la capacidad está en `ready_for_testing`, `testing`, `failed` o `validated` y hay frases de validación, pasa a `testing` y al terminar queda `validated` o `failed`.
- **Nunca** pasa a `enabled`: eso es la fase E.
- La última batería queda en `lastTest`.
- Al fusionar capacidades, las frases pasan al destino.

| Ruta (`/api/admin/lumi/capabilities/:id`) | Permiso |
|---|---|
| `GET /phrases` · `GET /test-runs` (últimas 20, sin detalle) · `GET /test-runs/:runId` | `lumi.capabilities.read` |
| `POST /phrases` · `DELETE /phrases/:phraseId` | `lumi.capabilities.manage` |
| `POST /test-runs` (`{kind: 'single', text, …}` o `{kind: 'battery'}`, y `forceSelector`) | `lumi.capabilities.test` (nuevo) |

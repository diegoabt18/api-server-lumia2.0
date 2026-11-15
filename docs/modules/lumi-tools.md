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
| `products.search` | `products.read` | «¿Cuánto stock queda de la vela ambar?» |
| `inventory.low` | `products.read` | «¿Qué productos se están agotando?» |
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
  `stock` → `products.read`, `order_attention` → `orders.read`; `routine_failed` es del propio
  usuario. El motor solo genera y notifica los tipos permitidos. Sin `lumi.use` no genera nada.
- **Qué se ve:** el listado y los cambios de estado ocultan los tipos sin permiso.
- **Lecturas truncadas:** si una lectura llega al límite de filas (200), ese tipo se marca como
  truncado y no se completa ninguna iniciativa de él en esa pasada. Así se evitan cierres falsos y
  reaperturas en bucle.

## Añadir una herramienta

1. Definir `LumiTool` en `catalog.ts`: nombre, etiqueta, capacidad, ejemplo, permiso, `match`
   (regla sobre texto normalizado) y `run` (lectura acotada y texto por plantilla).
2. Si necesita datos nuevos, añadir el puerto en `tool.types.ts` y el adaptador en `tool-adapters.ts`.
3. Añadir pruebas:
   - frases positivas y negativas en `tests/unit/lumi-tools.test.ts`;
   - la consulta real en `tests/integration/lumi-tools.integration.test.ts`;
   - si cambia el flujo, el E2E.

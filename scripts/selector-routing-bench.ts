/**
 * Banco de la selección en dos niveles (fase 4 del Desktop Agent). Compara, contra el selector real
 * del asistente (/api/v1/select con su Ollama):
 *   A) «antes»: el menú plano que se enviaba antes de añadir las herramientas del equipo;
 *   B) «dos niveles»: el menú de routeSelectorMenu (grupo por palabras clave, menú mixto y segunda
 *      llamada solo si el modelo elige un grupo), con todas las herramientas.
 *
 *   LUMI_ASSISTANT_URL=http://127.0.0.1:8001 LUMI_ASSISTANT_API_KEY=… npx tsx scripts/selector-routing-bench.ts
 *
 * Solo lee: no ejecuta herramientas ni toca bases de datos de la tienda. El asistente registra el
 * consumo de cada llamada en su propia base.
 */
import { PERMISSION_WILDCARD, type PermissionId } from '../src/common/permissions/registry.js'
import {
  LumiAssistantClient,
  type LumiSelectRequest,
  type LumiSelectResult,
} from '../src/modules/lumi/infrastructure/lumi-assistant.client.js'
import { selectorCatalog } from '../src/modules/lumi/selector/lumi-selector.js'
import { planLumiTurn } from '../src/modules/lumi/turn/turn-plan.js'
import {
  GROUP_TOOL_PREFIX,
  groupMenu,
  routeSelectorMenu,
  type LumiToolGroupId,
  type SelectorMenu,
} from '../src/modules/lumi/selector/tool-groups.js'

const CASES: Array<{
  message: string
  expected: string
  group: 'tienda' | 'musica' | 'equipo' | 'otro'
}> = [
  { message: '¿Cuánto vendimos esta semana?', expected: 'sales.summary', group: 'tienda' },
  { message: 'Busca el producto Lumi Vela', expected: 'products.search', group: 'tienda' },
  { message: '¿Cuántos pedidos hay pendientes?', expected: 'orders.count', group: 'tienda' },
  { message: '¿Qué categorías tenemos?', expected: 'categories.list', group: 'tienda' },
  { message: '¿Qué productos no tienen precio?', expected: 'products.unpriced', group: 'tienda' },
  { message: 'Ponme algo de Soda Stereo', expected: 'music.play', group: 'musica' },
  { message: 'Sube el volumen', expected: 'music.volume', group: 'musica' },
  { message: '¿Qué canción está sonando?', expected: 'music.current', group: 'musica' },
  { message: 'Salta a la siguiente', expected: 'music.next', group: 'musica' },
  { message: 'Dime qué está en el aire ahora mismo', expected: 'music.current', group: 'musica' },
  { message: 'Abre lumiadalistore.com en mi PC', expected: 'device.open_page', group: 'equipo' },
  {
    message: '¿Qué aplicaciones tengo abiertas en mi PC?',
    expected: 'device.windows',
    group: 'equipo',
  },
  { message: 'Pulsa el botón Enviar en la página', expected: 'device.click_page', group: 'equipo' },
  {
    message: 'Escribe Diego en el campo Nombre de la página',
    expected: 'device.type_page',
    group: 'equipo',
  },
  { message: '¿Está conectado mi computador?', expected: 'device.status', group: 'equipo' },
  { message: 'Lee los botones de la calculadora', expected: 'device.read_app', group: 'equipo' },
  { message: 'Hola, ¿cómo estás?', expected: 'chat', group: 'otro' },
  { message: '¿Qué clima hace hoy en Bogotá?', expected: 'weather.get', group: 'otro' },
  {
    message: 'Recuérdame mañana a las 9 llamar al proveedor',
    expected: 'reminders.create',
    group: 'otro',
  },
  { message: '¿Qué hora es?', expected: 'time.now', group: 'otro' },
]

const url = process.env.LUMI_ASSISTANT_URL
const apiKey = process.env.LUMI_ASSISTANT_API_KEY
if (!url || !apiKey) {
  console.error('LUMI_ASSISTANT_URL and LUMI_ASSISTANT_API_KEY are required')
  process.exit(2)
}
const client = new LumiAssistantClient({
  baseUrl: url.replace(/\/+$/, ''),
  apiKey,
  timeoutMs: 180_000,
})
const ALL = [PERMISSION_WILDCARD as PermissionId]
const USER = 'selector-bench'

function chosen(result: LumiSelectResult): string {
  return result.status === 'tool' && result.intents[0] ? result.intents[0].tool : result.status
}

interface Run {
  choice: string
  calls: number
  menu: number
  promptTokens: number
  latencyMs: number
}

async function call(message: string, menu: SelectorMenu): Promise<LumiSelectResult> {
  const payload: LumiSelectRequest = { message, ...menu }
  return client.select(USER, payload, 180_000)
}

/** «Antes»: el menú plano sin las herramientas del equipo (lo que se enviaba en producción). */
async function before(message: string): Promise<Run> {
  const full = selectorCatalog(undefined, ALL)
  const menu = {
    tools: full.tools.filter((t) => !t.name.startsWith('device.')),
    modules: full.modules.filter((m) => m !== 'equipo'),
  }
  const r = await call(message, menu)
  return {
    choice: chosen(r),
    calls: 1,
    menu: menu.tools.length,
    promptTokens: r.promptTokens ?? 0,
    latencyMs: r.latencyMs ?? 0,
  }
}

/** «Dos niveles»: lo mismo que hace planLumiTurn. */
async function twoLevel(message: string): Promise<Run> {
  const routed = routeSelectorMenu(message, undefined, ALL)
  let r = await call(message, routed.menu)
  let run: Run = {
    choice: chosen(r),
    calls: 1,
    menu: routed.menu.tools.length,
    promptTokens: r.promptTokens ?? 0,
    latencyMs: r.latencyMs ?? 0,
  }
  const picked = r.intents.find((i) => i.tool.startsWith(GROUP_TOOL_PREFIX))
  if (routed.mode === 'mixed' && picked) {
    const group = picked.tool.slice(GROUP_TOOL_PREFIX.length) as LumiToolGroupId
    const menu = groupMenu(group, undefined, ALL)
    r = await call(message, menu)
    run = {
      choice: chosen(r),
      calls: 2,
      menu: menu.tools.length,
      promptTokens: run.promptTokens + (r.promptTokens ?? 0),
      latencyMs: run.latencyMs + (r.latencyMs ?? 0),
    }
  }
  return { ...run, choice: `${run.choice}` }
}

/** «C»: el flujo completo de Lumi (reglas fijas y después el selector en dos niveles). */
async function pipeline(message: string): Promise<Run> {
  const { plan, trace } = await planLumiTurn(
    {
      userId: USER,
      message,
      permissionKeys: ALL,
      now: new Date(),
      timezone: 'America/Bogota',
      resolveEntity: async () => null,
    },
    { select: (userId, payload) => client.select(userId, payload, 180_000) },
  )
  const choice =
    trace.matches[0]?.tool ??
    trace.selector?.normalized?.intents[0]?.tool ??
    (plan.kind === 'model' ? 'chat' : plan.kind === 'missing_capability' ? 'missing' : plan.kind)
  return {
    choice,
    calls: trace.selector?.routing?.calls ?? 0,
    menu: trace.selector?.routing?.menuSize ?? 0,
    promptTokens: trace.selector?.promptTokens ?? 0,
    latencyMs: trace.selector?.latencyMs ?? 0,
  }
}

const rows: Array<{
  message: string
  expected: string
  group: string
  a: Run
  b: Run
  c: Run
  mode: string
}> = []
for (const c of CASES) {
  const mode = routeSelectorMenu(c.message, undefined, ALL).mode
  const a = await before(c.message)
  const b = await twoLevel(c.message)
  const full = await pipeline(c.message)
  rows.push({ ...c, a, b, c: full, mode })
  const mark = (r: Run) => (r.choice === c.expected ? 'OK ' : 'NO ')
  console.log(
    `${mark(a)}A ${a.choice.padEnd(18)} ${String(a.promptTokens).padStart(5)} tok ${String(a.latencyMs).padStart(6)} ms | ` +
      `${mark(b)}B ${b.choice.padEnd(18)} ${String(b.promptTokens).padStart(5)} tok ${String(b.latencyMs).padStart(6)} ms ` +
      `[${mode}, ${b.calls} llamada(s), menú ${b.menu}] | ${mark(full)}C ${full.choice.padEnd(18)} ` +
      `${full.calls ? `${full.calls} llamada(s)` : 'regla'} | ${c.message}`,
  )
}

const summary = (
  pick: (r: (typeof rows)[number]) => Run,
  filter: (r: (typeof rows)[number]) => boolean = () => true,
) => {
  const set = rows.filter(filter)
  const ok = set.filter((r) => pick(r).choice === r.expected).length
  const tokens = set.reduce((n, r) => n + pick(r).promptTokens, 0) / Math.max(1, set.length)
  const latency = set.reduce((n, r) => n + pick(r).latencyMs, 0) / Math.max(1, set.length)
  return `${ok}/${set.length} aciertos · ${Math.round(tokens)} tokens de prompt de media · ${Math.round(latency)} ms de media`
}
const notDevice = (r: (typeof rows)[number]) => r.group !== 'equipo'
console.log('\nSin mensajes del equipo (el menú anterior no tenía esas herramientas):')
console.log(`  A antes:       ${summary((r) => r.a, notDevice)}`)
console.log(`  B dos niveles: ${summary((r) => r.b, notDevice)}`)
console.log('Todos los mensajes:')
console.log(`  A antes:       ${summary((r) => r.a)}`)
console.log(`  B dos niveles: ${summary((r) => r.b)}`)
console.log('Flujo completo de Lumi (reglas + dos niveles):')
console.log(`  C:             ${summary((r) => r.c)}`)

import { PERMISSION_REGISTRY, type PermissionId } from '../../../common/permissions/registry.js'
import type { LumiSelectorArg, LumiTool, LumiToolContext, LumiToolName, LumiToolResult } from './tool.types.js'

/**
 * Módulo de música de Lumi. La música suena en el servidor del asistente (local-ai-assistant,
 * `app/services/music/commands.py`); el Server solo propone el comando y muestra la respuesta.
 *
 * Copia estática del catálogo `GET /music/tools` (nombre, argumentos y permiso), no una lectura en
 * vivo: el registro de herramientas del Server es cerrado (nombres tipados, capacidad en
 * `lumi_capabilities`, permiso comprobado aquí). Así el asistente nunca decide qué ejecuta el
 * Server. Si el asistente añade o cambia un comando, se actualiza este archivo.
 *
 * Flujo: el selector propone la herramienta → `fromArgs` valida los argumentos → `run` llama a
 * POST /music/commands y devuelve su `text` tal cual (texto determinista, el modelo no lo reescribe).
 */

/** Igual que QUERY_MAX_CHARS del asistente. */
const QUERY_MAX_CHARS = 200

/** Respuesta cuando el selector no encuentra la orden de música (en lugar de registrar una capacidad). */
export const MUSIC_HELP_REPLY =
  'Con la música puedo poner una canción o un artista, buscar canciones, pausar, reanudar, pasar a la siguiente o a la anterior, decirte qué suena y cambiar la salida (cable o Bluetooth). Por ejemplo: «Busca la canción Pan Amore Conspiracy» o «Pon algo de Soda Stereo».'

const DISABLED_TEXT = 'La música no está activada en el asistente.'
const UNAVAILABLE_TEXT = 'No pude comunicarme con el reproductor de música ahora mismo. Inténtalo de nuevo en un momento.'
const REJECTED_TEXT = 'El reproductor de música no aceptó esa orden.'

type MusicInput = Record<string, string>

function queryText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.replace(/\s+/g, ' ').trim()
  return text ? text.slice(0, QUERY_MAX_CHARS) : null
}

const OUTPUT_MODES = ['aux', 'bluetooth'] as const
type OutputMode = (typeof OUTPUT_MODES)[number]

const BLUETOOTH_WORDS = /\b(bluetooth|bt|parlante|inalambric[oa])\b/
const AUX_WORDS = /\b(aux|auxiliar|cable|jack|linea)\b/

/** La salida sale del mensaje (regla del Server); solo si no la nombra se acepta la del modelo. */
function outputMode(value: unknown, normalized: string): OutputMode | null {
  const bt = BLUETOOTH_WORDS.test(normalized)
  const aux = AUX_WORDS.test(normalized)
  if (bt !== aux) return bt ? 'bluetooth' : 'aux'
  return typeof value === 'string' && (OUTPUT_MODES as readonly string[]).includes(value) ? (value as OutputMode) : null
}

/* ───────────── Reglas (etapa 1): órdenes de música claras, sin depender del modelo ───────────── */

/** Limpia el término capturado por una regla: sin signos ni comillas al principio o al final. */
function ruleQuery(raw: string | undefined): string | null {
  const text = (raw ?? '').replace(/[?¿!¡.,;:"'«»]+/g, ' ').replace(/\s+/g, ' ').trim()
  return text.length >= 2 ? text.slice(0, QUERY_MAX_CHARS) : null
}

const SONG = String.raw`(?:cancion(?:es)?|tema|temas|musica|artista)`
const ARTICLE = String.raw`(?:(?:la|las|el|los|una|un|esta|esa|estas)\s+)?`
const SEARCH_RULE = new RegExp(
  String.raw`\bbusca(?:r|me|s)?\s+` +
    ARTICLE +
    SONG +
    String.raw`\s+(?:(?:de|del|llamad[oa]s?|que se llaman?|que coincidan? con|parecidas? a)\s+)?(.+)$`,
)
const PLAY_RULE = new RegExp(
  String.raw`\b(?:reproduce|reproducir|reproduceme|quiero escuchar|pon(?:me|nos)?|coloca(?:me)?)\s+` +
    ARTICLE +
    String.raw`(?:` +
    SONG +
    String.raw`\s+(?:de\s+)?|algo de\s+)(.+)$`,
)
const PLAY_ANY_RULE = /\b(?:pon(?:me|nos)?|reproduce|quiero escuchar)\s+(?:algo de\s+|un poco de\s+)?musica$/
// Verbo seguido de «música/canción»: «pon música para la fiesta» no es pausar.
const PAUSE_RULE = /\b(?:pausa|pausar|deten|detener|para|parar|quita|quitar|apaga|apagar)\s+(?:la |esta |el )?(?:musica|cancion|tema)\b/
const RESUME_RULE = /\b(?:reanuda|reanudar|continua|continuar|sigue con|vuelve a poner)\s+(?:la |esta |el )?(?:musica|cancion|tema)\b/
const NEXT_RULE =
  /\b(?:siguiente cancion|cancion siguiente|pasa a la siguiente|siguiente tema|otra cancion|salta(?:r|te)? (?:esta |la )?cancion|cambia de cancion)\b/
const PREVIOUS_RULE = /\b(?:cancion anterior|anterior cancion|tema anterior|vuelve a la (?:cancion )?anterior)\b/
const CURRENT_RULE = /\bque (?:cancion|tema|musica) (?:esta )?(?:sonando|suena)\b|\bque (?:esta )?sonando\b|\bque suena\b/
const OUTPUT_STATUS_RULE = /\bpor donde (?:esta )?(?:sonando|suena)\b|\b(?:esta conectado el parlante|parlante (?:esta )?conectado)\b/
const OUTPUT_TARGET = /\b(?:musica|suene|sonar|suena|salida|pasala|ponla|cancion|audio)\b/

const RULES: Partial<Record<LumiToolName, (normalized: string) => MusicInput | null>> = {
  'music.search': (t) => {
    const query = ruleQuery(SEARCH_RULE.exec(t)?.[1])
    return query ? { query } : null
  },
  'music.output_status': (t) => (OUTPUT_STATUS_RULE.test(t) ? {} : null),
  'music.output': (t) => {
    if (!OUTPUT_TARGET.test(t) || OUTPUT_STATUS_RULE.test(t)) return null
    const mode = outputMode(undefined, t)
    return mode ? { mode } : null
  },
  'music.current': (t) => (CURRENT_RULE.test(t) ? {} : null),
  'music.next': (t) => (NEXT_RULE.test(t) ? {} : null),
  'music.previous': (t) => (PREVIOUS_RULE.test(t) ? {} : null),
  'music.pause': (t) => (PAUSE_RULE.test(t) ? {} : null),
  'music.resume': (t) => (RESUME_RULE.test(t) ? {} : null),
  // «Poner» es la más general: cede ante cualquier otra orden («pon la música por Bluetooth» es la salida).
  'music.play': (t): MusicInput | null => {
    if (Object.entries(RULES).some(([name, rule]) => name !== 'music.play' && rule?.(t))) return null
    if (PLAY_ANY_RULE.test(t)) return {}
    const query = ruleQuery(PLAY_RULE.exec(t)?.[1])
    return query ? { query } : null
  },
}

const QUERY_ARG: LumiSelectorArg = { name: 'query', kind: 'str', description: 'canción o artista tal como lo dice el usuario' }

interface MusicToolSpec {
  name: LumiToolName
  label: string
  capability: string
  example: string
  description: string
  permission: PermissionId
  args: readonly LumiSelectorArg[]
  ask?: string
  fromArgs: NonNullable<LumiTool<MusicInput>['selector']>['fromArgs']
}

const noArgs = () => ({ input: {} })

/** Llama al asistente y convierte cualquier fallo en un aviso amable (nunca rompe el turno). */
async function runCommand(ctx: LumiToolContext, tool: string, input: MusicInput): Promise<LumiToolResult> {
  if (!ctx.deps.music) return { text: UNAVAILABLE_TEXT, rows: 0 }
  let outcome
  try {
    outcome = await ctx.deps.music.command(ctx.userId, tool, input)
  } catch {
    return { text: UNAVAILABLE_TEXT, rows: 0 }
  }
  switch (outcome.status) {
    case 'done':
      return { text: outcome.text, rows: outcome.ok ? 1 : 0 }
    case 'disabled':
      return { text: DISABLED_TEXT, rows: 0 }
    case 'rejected':
      return { text: REJECTED_TEXT, rows: 0 }
    case 'unavailable':
      return { text: UNAVAILABLE_TEXT, rows: 0 }
  }
}

function musicTool(spec: MusicToolSpec): LumiTool<MusicInput> {
  return {
    name: spec.name,
    capabilityKey: `tool-${spec.name.replace(/[._]/g, '-')}`,
    // Nace habilitada: ya la valida el asistente y la limitan sus propios permisos (music.read /
    // music.control, que nadie tiene por defecto) y MUSIC_ENABLED. Se puede deshabilitar en Lumia Admin.
    enabledByDefault: true,
    label: spec.label,
    capability: spec.capability,
    example: spec.example,
    permission: spec.permission,
    external: { effect: spec.permission === PERMISSION_REGISTRY.MUSIC_CONTROL ? 'control' : 'read' },
    // Reglas solo para órdenes claras; el resto lo propone el selector.
    match: (normalized) => RULES[spec.name]?.(normalized) ?? null,
    selector: {
      description: spec.description,
      module: 'musica',
      args: spec.args,
      ...(spec.ask ? { ask: spec.ask } : {}),
      fromArgs: spec.fromArgs,
    },
    run: (ctx, input) => runCommand(ctx, spec.name, input),
  }
}

const READ = PERMISSION_REGISTRY.MUSIC_READ
const CONTROL = PERMISSION_REGISTRY.MUSIC_CONTROL

const SPECS: readonly MusicToolSpec[] = [
  {
    name: 'music.play',
    label: 'Poniendo música',
    capability: 'Poner música: una canción o un artista (o reanudar si no dices cuál)',
    example: 'Pon algo de Soda Stereo',
    description: 'Poner o reproducir música: una canción o un artista, o reanudar si no dice cuál',
    permission: CONTROL,
    args: [QUERY_ARG],
    fromArgs(args) {
      const query = queryText(args.query)
      const input: MusicInput = query ? { query } : {}
      return { input }
    },
  },
  {
    name: 'music.search',
    label: 'Buscando canciones',
    capability: 'Buscar canciones sin reproducirlas',
    example: 'Busca canciones de Shakira',
    description: 'Buscar canciones sin reproducirlas',
    permission: READ,
    args: [{ ...QUERY_ARG, required: true }],
    ask: '¿Qué canción o artista busco?',
    fromArgs(args) {
      const query = queryText(args.query)
      return query ? { input: { query } } : { missing: ['query'] }
    },
  },
  {
    name: 'music.pause',
    label: 'Pausando la música',
    capability: 'Pausar la música',
    example: 'Pausa la música',
    description: 'Pausar la música',
    permission: CONTROL,
    args: [],
    fromArgs: noArgs,
  },
  {
    name: 'music.resume',
    label: 'Reanudando la música',
    capability: 'Reanudar la música en pausa',
    example: 'Reanuda la música',
    description: 'Reanudar la música en pausa',
    permission: CONTROL,
    args: [],
    fromArgs: noArgs,
  },
  {
    name: 'music.next',
    label: 'Pasando de canción',
    capability: 'Pasar a la siguiente canción',
    example: 'Siguiente canción',
    description: 'Pasar a la siguiente canción',
    permission: CONTROL,
    args: [],
    fromArgs: noArgs,
  },
  {
    name: 'music.previous',
    label: 'Volviendo a la canción anterior',
    capability: 'Volver a la canción anterior',
    example: 'Pon la canción anterior',
    description: 'Volver a la canción anterior',
    permission: CONTROL,
    args: [],
    fromArgs: noArgs,
  },
  {
    name: 'music.current',
    label: 'Mirando qué suena',
    capability: 'Saber qué canción está sonando',
    example: '¿Qué canción está sonando?',
    description: 'Qué canción está sonando ahora',
    permission: READ,
    args: [],
    fromArgs: noArgs,
  },
  {
    name: 'music.output',
    label: 'Cambiando la salida de audio',
    capability: 'Cambiar por dónde suena la música: cable auxiliar o parlante Bluetooth',
    example: 'Pon la música por el parlante Bluetooth',
    description: 'Cambiar por dónde suena la música: cable auxiliar o parlante Bluetooth',
    permission: CONTROL,
    args: [{ name: 'mode', kind: OUTPUT_MODES, required: true, description: 'aux = cable o jack; bluetooth = parlante inalámbrico' }],
    ask: '¿Por dónde quieres que suene: por el cable auxiliar o por el parlante Bluetooth?',
    fromArgs(args, normalized) {
      const mode = outputMode(args.mode, normalized)
      return mode ? { input: { mode } } : { missing: ['mode'] }
    },
  },
  {
    name: 'music.output_status',
    label: 'Revisando la salida de audio',
    capability: 'Saber por dónde suena la música y si el parlante está conectado',
    example: '¿Por dónde está sonando la música?',
    description: 'Por dónde está sonando la música y si el parlante está conectado',
    permission: READ,
    args: [],
    fromArgs: noArgs,
  },
]

export const MUSIC_TOOLS: ReadonlyArray<LumiTool<MusicInput>> = SPECS.map(musicTool)

import type { PermissionId } from '../../../common/permissions/registry.js'
import type { EnabledTools } from '../tools/catalog.js'
import { LUMI_MODULES, type LumiModule } from '../tools/tool.types.js'
import { selectorCatalog, type SelectorToolSpec } from './lumi-selector.js'
import { plainText } from './selector-text.js'

/**
 * Selección en dos niveles (fase 4). El menú que recibe el selector (Qwen) tiene un límite (40
 * entradas en el asistente) y cada entrada alarga el prompt, que en CPU es lo que más tarda.
 *
 *  1. Grupo por palabras clave, sin modelo: si el mensaje apunta claramente a UN grupo (música,
 *     equipo), el selector recibe solo las herramientas de ese grupo.
 *  2. Si no, y el menú completo cabe, se envía como hasta ahora (sin cambios de comportamiento).
 *  3. Si no cabe, se envía un menú mixto: las herramientas de la tienda y una entrada por cada
 *     grupo externo (`grupo.musica`, `grupo.equipo`). Solo si el modelo elige un grupo hay una
 *     segunda llamada con las herramientas de ese grupo.
 *
 * Las herramientas de delegación (web, hora, recordatorios) van siempre.
 */

/** Entradas que el asistente acepta en un menú (local-ai-assistant `SelectRequest.tools`). */
export const SELECTOR_MAX_TOOLS = 40

export type LumiToolGroupId = 'tienda' | 'musica' | 'equipo'

export interface LumiToolGroup {
  id: LumiToolGroupId
  modules: readonly LumiModule[]
  /** Descripción de la entrada del grupo en el menú mixto (≤ 200 caracteres). */
  description: string
  /** Palabras que lo identifican sin ambigüedad (sobre texto sin tildes ni mayúsculas). */
  keywords: RegExp | null
}

const MUSIC_KEYWORDS =
  /\b(?:musica|cancion(?:es)?|temas?|artistas?|album(?:es)?|reproduc\w*|escuch\w*|volumen|cola|suena|sonando|pausa\w*|parlante|bluetooth|aleatorio|repit\w*|repeticion|autoplay|playlist|lista de reproduccion|youtube|siguiente|anterior|salta(?:r|te)?|ponme|pon algo)\b/

const DEVICE_KEYWORDS =
  /\b(?:(?:mi|el|este|ese|del|al) (?:pc|computador\w*|ordenador|equipo|portatil|laptop)|navegador|pagina(?: web)?|sitio web|pestanas?|ventanas?|aplicacion(?:es)?|programas? abiertos?|escritorio|chrome|edge|calculadora|bloc de notas|boton|haz clic|da clic|clic en|pulsa|presiona|escribe en|campo)\b|\bhttps?:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|co|net|org|io|dev|app|es|gov|edu)\b/

const STORE_MODULES = LUMI_MODULES.filter((m) => m !== 'musica' && m !== 'equipo')

export const LUMI_TOOL_GROUPS: readonly LumiToolGroup[] = [
  {
    id: 'tienda',
    modules: STORE_MODULES,
    description:
      'Datos de la tienda: pedidos, ventas, productos, inventario, categorías, iniciativas y notificaciones',
    keywords: null,
  },
  {
    id: 'musica',
    modules: ['musica'],
    description:
      'Música del asistente: poner, buscar, pausar, cambiar o recomendar canciones, la cola, el volumen y la salida de audio',
    keywords: MUSIC_KEYWORDS,
  },
  {
    id: 'equipo',
    modules: ['equipo'],
    description:
      'Equipos de escritorio del usuario: abrir o leer páginas en su navegador, ver sus aplicaciones, pulsar botones o escribir en campos',
    keywords: DEVICE_KEYWORDS,
  },
]

/** Prefijo de las entradas de grupo del menú mixto (cumple el patrón de nombres del asistente). */
export const GROUP_TOOL_PREFIX = 'grupo.'

export function groupOfModule(module: string): LumiToolGroup | undefined {
  return LUMI_TOOL_GROUPS.find((g) => (g.modules as readonly string[]).includes(module))
}

export interface SelectorMenu {
  tools: SelectorToolSpec[]
  modules: string[]
}

export type RoutedMenu =
  /** Menú completo de siempre (cabe en el límite). */
  | { mode: 'flat'; menu: SelectorMenu }
  /** Las palabras clave señalan un único grupo: solo sus herramientas. */
  | { mode: 'grouped'; group: LumiToolGroupId; menu: SelectorMenu }
  /** No cabe: herramientas de la tienda y una entrada por grupo externo. */
  | { mode: 'mixed'; menu: SelectorMenu; groups: LumiToolGroupId[] }

/** Menú con solo las herramientas de un grupo (y las delegaciones). */
export function groupMenu(
  group: LumiToolGroupId,
  enabled?: EnabledTools,
  keys?: readonly PermissionId[],
): SelectorMenu {
  const spec = LUMI_TOOL_GROUPS.find((g) => g.id === group)!
  return selectorCatalog(enabled, keys, new Set(spec.modules))
}

/**
 * Decide el menú del selector para un mensaje. Solo cuenta un grupo si el usuario tiene alguna de
 * sus herramientas en el menú completo (por permisos y habilitación).
 */
export function routeSelectorMenu(
  message: string,
  enabled?: EnabledTools,
  keys?: readonly PermissionId[],
): RoutedMenu {
  const full = selectorCatalog(enabled, keys)
  const text = plainText(message)
  const available = LUMI_TOOL_GROUPS.filter((g) => groupMenuHasTools(g, enabled, keys))
  const hits = available.filter((g) => g.keywords?.test(text))
  if (hits.length === 1) {
    const group = hits[0]!.id
    return { mode: 'grouped', group, menu: groupMenu(group, enabled, keys) }
  }
  if (full.tools.length <= SELECTOR_MAX_TOOLS) return { mode: 'flat', menu: full }

  const external = available.filter((g) => g.id !== 'tienda')
  const store = groupMenu('tienda', enabled, keys)
  return {
    mode: 'mixed',
    groups: external.map((g) => g.id),
    menu: {
      tools: [
        ...store.tools,
        ...external.map((g) => ({
          name: `${GROUP_TOOL_PREFIX}${g.id}`,
          description: g.description,
          args: [],
        })),
      ],
      modules: [
        ...new Set([...store.modules, ...external.flatMap((g) => g.modules as readonly string[])]),
      ],
    },
  }
}

function groupMenuHasTools(
  group: LumiToolGroup,
  enabled?: EnabledTools,
  keys?: readonly PermissionId[],
): boolean {
  const modules = new Set<string>(group.modules)
  const { tools } = selectorCatalog(enabled, keys, modules, false)
  return tools.length > 0
}

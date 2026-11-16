import { AppError } from '../../../../common/errors/app.error.js'
import { PERMISSION_REGISTRY } from '../../../../common/permissions/registry.js'
import type { LumiTool } from '../../tools/tool.types.js'
import type { CapabilitySpec, LumiCapability } from '../domain/capability.types.js'

/**
 * Borrador de especificación con IA. El Server escribe las instrucciones y el contexto (catálogo de
 * herramientas, métodos de lectura y permisos que existen de verdad); el modelo solo propone texto.
 * La salida se valida aquí: un permiso o una herramienta que no existen se descartan. El borrador
 * nunca se guarda: el administrador lo revisa en el formulario y lo guarda al confirmar.
 */

type DraftTool = Pick<LumiTool<never>, 'name' | 'capability' | 'permission'> & {
  selector?: { module: string }
}

export interface SpecDraftRequest {
  instructions: string
  input: string
  maxTokens: number
}

/** Mismos límites que capabilitySpecSchema. */
const FIELD_MAX: Record<keyof CapabilitySpec, number> = {
  expectedResult: 1000,
  parameters: 1000,
  rules: 1000,
  proposedPermission: 100,
  dataSource: 300,
  relatedTool: 100,
  notes: 2000,
}
const FIELDS = Object.keys(FIELD_MAX) as Array<keyof CapabilitySpec>

const PHRASES_MAX = 12
const INPUT_MAX_CHARS = 8000

/**
 * Métodos de lectura que ya usan las herramientas (espejo de LumiToolDeps en tool.types.ts).
 * Si se añade uno allí, añádelo aquí para que el borrador lo conozca.
 */
const READ_PORTS = [
  'orders.recent(limit): últimos pedidos con referencia, fecha, estado, pago, entrega, total y número de artículos (sin datos del cliente)',
  'orders.findByReference(term, limit): pedido por referencia con las mismas columnas; NO incluye las líneas de producto',
  'orders.countByStatus(rango opcional): número de pedidos por estado',
  'orders.salesSummary(desde, hasta): ventas, pedidos vendidos, reembolsos y productos más vendidos del periodo',
  'products.search(term, limit): productos por nombre con estado, stock disponible y precio mínimo/máximo',
  'products.lowStock(umbral, limit): productos activos con stock bajo o agotados',
  'products.unpriced(limit): productos sin ninguna variante con precio',
  'products.untaxed(limit): productos sin IVA configurado',
  'initiatives.list(userId, permisos, limit): iniciativas de Lumi del usuario',
  'notifications.countUnread(userId) y notifications.recentUnread(userId, limit): notificaciones sin leer',
] as const

/** Permisos de lectura existentes: el borrador solo puede proponer uno de estos. */
export const READ_PERMISSIONS: readonly string[] = Object.values(PERMISSION_REGISTRY).filter((p) => p.endsWith('.read'))

const INSTRUCTIONS = [
  'Eres analista técnico de Lumia. Redactas la especificación de una herramienta de Lumi: una consulta de SOLO LECTURA del panel de administración que responde en texto plano.',
  'Responde ÚNICAMENTE con un objeto JSON válido, sin Markdown ni texto alrededor, con estas claves de tipo cadena y en español:',
  'expectedResult: qué debe responder Lumi y con qué datos, en una o dos frases.',
  'parameters: datos que se extraen de la frase del usuario, con un ejemplo; vacío si no necesita ninguno.',
  'rules: criterios exactos (filtros, orden, límite de filas, qué hacer si no hay resultados). Nunca datos personales de clientes (nombre, correo, teléfono, dirección).',
  'proposedPermission: exactamente uno de los permisos de la lista dada.',
  'dataSource: el método de lectura de la lista que sirve; si ninguno basta, empieza por «Falta:» y describe el método de lectura que habría que añadir y en qué repositorio.',
  'relatedTool: exactamente el nombre de la herramienta más parecida del catálogo, o cadena vacía.',
  'notes: dudas, ambigüedades y casos límite para quien la programe.',
  'No inventes campos, colecciones, permisos ni herramientas que no aparezcan en el contexto. Si algo no se puede saber, dilo en notes.',
  'Si el equipo ya escribió un campo, respétalo y complétalo sin contradecirlo.',
].join('\n')

const oneLine = (v: string) => v.replace(/\s+/g, ' ').trim()

/** Instrucciones fijas y contexto (capacidad, frases reales, catálogo, lecturas y permisos). */
export function buildSpecDraftRequest(
  capability: Pick<LumiCapability, 'title' | 'description' | 'module' | 'samples' | 'spec' | 'toolName'>,
  requests: readonly string[],
  tools: readonly DraftTool[],
): SpecDraftRequest {
  const phrases = [...new Set([...requests, ...capability.samples].map(oneLine).filter(Boolean))].slice(0, PHRASES_MAX)
  const written = FIELDS.filter((key) => capability.spec[key].trim())

  const lines = [
    `Capacidad: ${oneLine(capability.title)}`,
    `Módulo: ${capability.module}`,
    ...(capability.description ? [`Descripción: ${oneLine(capability.description)}`] : []),
    ...(capability.toolName ? [`Herramienta que ya la implementa: ${capability.toolName}`] : []),
    '',
    'Lo que pidieron los usuarios (frases reales):',
    ...(phrases.length ? phrases.map((p) => `- «${p}»`) : ['- (sin frases)']),
  ]
  if (written.length) {
    lines.push('', 'Ya escrito por el equipo:', ...written.map((key) => `- ${key}: ${oneLine(capability.spec[key])}`))
  }
  lines.push(
    '',
    'Catálogo de herramientas existentes (nombre · módulo · permiso · qué hace):',
    ...tools.map((t) => `- ${t.name} · ${t.selector?.module ?? 'sin módulo'} · ${t.permission ?? 'sin permiso'} · ${t.capability}`),
    '',
    'Métodos de lectura disponibles:',
    ...READ_PORTS.map((p) => `- ${p}`),
    '',
    `Permisos de lectura existentes: ${READ_PERMISSIONS.join(', ')}`,
  )

  return { instructions: INSTRUCTIONS, input: lines.join('\n').slice(0, INPUT_MAX_CHARS), maxTokens: 1000 }
}

/** Texto multilínea sin caracteres de control (salvo saltos de línea), recortado a su límite. */
function cleanField(value: unknown, max: number): string {
  let text: string
  if (typeof value === 'string') text = value
  else if (Array.isArray(value)) text = value.filter((v) => typeof v === 'string' || typeof v === 'number').join('\n')
  else if (typeof value === 'number') text = String(value)
  else return ''
  const printable = Array.from(text, (ch) => {
    const code = ch.charCodeAt(0)
    return code === 10 || (code >= 32 && code !== 127) ? ch : ' '
  }).join('')
  return printable
    .replace(/\*\*|__|`/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max)
    .trim()
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed: unknown = JSON.parse(raw.slice(start, end + 1))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * Convierte la salida del modelo en una especificación válida. El permiso y la herramienta
 * relacionada solo se aceptan si existen; lo demás se limpia y se recorta. Nunca devuelve vacío.
 */
export function parseSpecDraft(raw: string, tools: readonly Pick<DraftTool, 'name'>[]): CapabilitySpec {
  const json = extractJsonObject(raw)
  if (!json) throw new AppError(502, 'La IA no devolvió una especificación válida. Inténtalo de nuevo.', 'LUMI_INVALID_SUGGESTION')

  const spec = Object.fromEntries(FIELDS.map((key) => [key, cleanField(json[key], FIELD_MAX[key])])) as CapabilitySpec

  const permission = spec.proposedPermission.toLowerCase().replace(/[^a-z.]/g, '')
  spec.proposedPermission = READ_PERMISSIONS.includes(permission) ? permission : ''

  const toolNames = new Set(tools.map((t) => t.name as string))
  const tool = spec.relatedTool.replace(/[^a-z.]/gi, '').toLowerCase()
  spec.relatedTool = toolNames.has(tool) ? tool : ''

  if (FIELDS.every((key) => !spec[key])) {
    throw new AppError(502, 'La IA no devolvió una sugerencia. Inténtalo de nuevo.', 'LUMI_EMPTY_SUGGESTION')
  }
  return spec
}

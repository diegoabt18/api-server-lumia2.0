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
  /** Baja: es una salida estructurada, no texto creativo. */
  temperature: number
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
  'products.taxed(limit): productos con IVA configurado y su tasa, en orden alfabético',
  'categories.list(limit): categorías en orden alfabético con estado y número de productos (sin subcategorías)',
  'initiatives.list(userId, permisos, limit): iniciativas de Lumi del usuario',
  'notifications.countUnread(userId): notificaciones sin leer del usuario',
  'notifications.recentUnread(userId, limit): últimas notificaciones sin leer del usuario',
] as const

/** Nombre del método («orders.recent») → firma tal como la ve quien programa. */
const READ_PORT_SIGNATURES: ReadonlyMap<string, string> = new Map(
  READ_PORTS.map((port) => {
    const signature = port.slice(0, port.indexOf(':'))
    return [signature.slice(0, signature.indexOf('(')), signature]
  }),
)

/**
 * Repositorios del Server donde se añadiría un método de lectura que falta. Solo orienta al modelo
 * («Falta: … en category.repository»); no se valida porque el texto lo revisa una persona.
 */
const REPOSITORIES = [
  'catalog: category.repository (categorías), subcategory.repository, product.repository, inventory.repository, promotion.repository',
  'sales: order.repository (pedidos), review.repository (reseñas), question.repository (preguntas)',
  'production: material.repository, recipe.repository, supplier.repository',
  'payments: payment.repository',
] as const

/** Permisos de lectura existentes: el borrador solo puede proponer uno de estos. */
export const READ_PERMISSIONS: readonly string[] = Object.values(PERMISSION_REGISTRY).filter((p) => p.endsWith('.read'))

const INSTRUCTIONS = [
  'Eres analista técnico de Lumia. Redactas la especificación de una herramienta de Lumi: una consulta de SOLO LECTURA del panel de administración que responde en texto plano.',
  'Responde ÚNICAMENTE con un objeto JSON válido, sin Markdown ni texto alrededor, con estas claves de tipo cadena y en español:',
  'expectedResult: qué debe responder Lumi y con qué datos, en una o dos frases.',
  'parameters: datos que se extraen de la frase del usuario, con un ejemplo; vacío si no necesita ninguno.',
  'rules: criterios exactos (orden, límite de filas, qué hacer si no hay resultados). No conviertas palabras de la frase en filtros. Nunca datos personales de clientes.',
  'proposedPermission: exactamente uno de los permisos de la lista dada.',
  'dataSourceMethod: el nombre exacto (p. ej. «orders.recent») del único método de lectura de la lista que devuelve esos datos, o cadena vacía si ninguno los devuelve. No elijas un método de otro tema.',
  'missingMethod: solo si dataSourceMethod está vacío, el método que habría que añadir (nombre, parámetros, qué devuelve) y en qué repositorio de la lista.',
  'relatedTool: exactamente el nombre de la herramienta más parecida del catálogo, o cadena vacía.',
  'notes: dudas, ambigüedades y casos límite para quien la programe.',
  'No inventes campos, métodos, permisos ni herramientas que no aparezcan en el contexto. Si algo no se puede saber, dilo en notes.',
  'Si el equipo ya escribió un campo, respétalo y complétalo sin contradecirlo.',
].join('\n')

/** Ejemplo de salida (otro tema, a propósito) para fijar el formato en modelos pequeños. */
const EXAMPLE_OUTPUT = JSON.stringify({
  expectedResult: 'Lista de los proveedores activos con nombre y número de materiales que suministran.',
  parameters: '',
  rules: 'Orden alfabético. Máximo 30. Si no hay, responder «No hay proveedores activos».',
  proposedPermission: 'suppliers.read',
  dataSourceMethod: '',
  missingMethod: 'suppliers.active(limit): proveedores activos con nombre y número de materiales, en supplier.repository',
  relatedTool: '',
  notes: 'Confirmar si se incluyen los proveedores pausados.',
})

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
    'Métodos de lectura disponibles (los únicos que existen):',
    ...READ_PORTS.map((p) => `- ${p}`),
    '',
    'Repositorios donde se puede añadir un método:',
    ...REPOSITORIES.map((r) => `- ${r}`),
    '',
    `Permisos de lectura existentes: ${READ_PERMISSIONS.join(', ')}`,
    '',
    'Ejemplo del formato de salida (para otra capacidad):',
    EXAMPLE_OUTPUT,
  )

  return { instructions: INSTRUCTIONS, input: lines.join('\n').slice(0, INPUT_MAX_CHARS), maxTokens: 1000, temperature: 0.2 }
}

/**
 * «Origen de los datos» lo compone el Server: un método que existe (con su firma) o «Falta: …».
 * Así no llega al formulario una mezcla de métodos reales e inventados. Si el modelo devolvió el
 * formato antiguo (`dataSource` libre), se acepta solo si empieza por «Falta:» o nombra un método real.
 */
function composeDataSource(json: Record<string, unknown>): string {
  const method = cleanField(json.dataSourceMethod, 100).replace(/[^a-z.]/gi, '')
  const signature = [...READ_PORT_SIGNATURES].find(([name]) => name.toLowerCase() === method.toLowerCase())?.[1]
  if (signature) return signature

  const missing = cleanField(json.missingMethod, FIELD_MAX.dataSource).replace(/^falta:\s*/i, '')
  if (missing) return `Falta: ${missing}`.slice(0, FIELD_MAX.dataSource)

  const legacy = cleanField(json.dataSource, FIELD_MAX.dataSource)
  if (/^falta:/i.test(legacy)) return legacy
  return READ_PORT_SIGNATURES.get(legacy.replace(/\(.*$/s, '').trim()) ?? ''
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
  spec.dataSource = composeDataSource(json)

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

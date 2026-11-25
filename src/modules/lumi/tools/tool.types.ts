import type { PermissionId } from '../../../common/permissions/registry.js'
import type { LumiInitiative } from '../initiatives/domain/initiative.types.js'
import type { LumiReference } from '../references/lumi-references.js'

/**
 * Catálogo de herramientas de Lumi. Una herramienta es una consulta de SOLO LECTURA que el Server
 * ejecuta con los permisos del usuario y responde con texto determinista (plantilla), sin modelo.
 * Excepción: las de música (`external`), que controlan el reproductor del asistente con un comando
 * cerrado y también responden con texto determinista.
 *
 * Reglas del catálogo:
 *  - Nunca hay "ejecutar endpoint arbitrario": solo las herramientas registradas aquí.
 *  - El permiso se comprueba en el Server antes de leer nada; el modelo no participa en esa decisión.
 *  - La entrada se valida (forma cerrada) y los resultados se acotan en filas y en longitud.
 *  - No se devuelven datos personales de clientes (nombre, correo, teléfono, dirección).
 */

export type LumiToolName =
  | 'orders.lookup'
  | 'orders.count'
  | 'orders.recent'
  | 'sales.summary'
  | 'inventory.low'
  | 'products.search'
  | 'initiatives.list'
  | 'notifications.unread'
  | 'products.unpriced'
  | 'products.untaxed'
  | 'products.taxed'
  | 'categories.list'
  | 'music.play'
  | 'music.search'
  | 'music.pause'
  | 'music.resume'
  | 'music.next'
  | 'music.previous'
  | 'music.current'
  | 'music.output'
  | 'music.output_status'
  | 'music.enqueue'
  | 'music.recommend'
  | 'music.shuffle'
  | 'music.repeat'
  | 'music.autoplay'
  | 'music.clear_queue'
  | 'music.queue'
  | 'music.jump'
  | 'music.stop'
  | 'music.volume'
  | 'music.seek'
  | 'device.status'
  | 'device.open_page'
  | 'device.play_music'
  | 'device.read_page'
  | 'device.click_page'
  | 'device.type_page'
  | 'device.windows'
  | 'device.read_app'
  | 'device.click_app'
  | 'device.type_app'

/** Fila de pedido sin datos del cliente. */
export interface AssistantOrderRow {
  /** Id del pedido, para abrirlo desde el chat. Nunca se muestra en el texto. */
  id: string | null
  orderNumber: string | null
  reference: string | null
  createdAt: string | null
  status: string | null
  paymentStatus: string | null
  fulfillmentStatus: string | null
  total: number | null
  itemCount: number
}

export interface AssistantProductRow {
  id: string
  name: string
  status: string
  available: number
  minPrice: number | null
  maxPrice: number | null
}

export interface AssistantSalesSummary {
  /** Pedidos creados en el periodo, en cualquier estado. */
  orders: number
  /** Pedidos que cuentan como venta (pagados, enviados o entregados). */
  soldOrders: number
  revenue: number
  refunds: number
  topProducts: Array<{ name: string; units: number; revenue: number }>
}

/**
 * Puertos de lectura que usan las herramientas. Se implementan con los repositorios del Server
 * (ver tool-adapters.ts) y con dobles en las pruebas.
 */
export interface LumiToolDeps {
  orders: {
    recent(limit: number): Promise<AssistantOrderRow[]>
    findByReference(term: string, limit: number): Promise<AssistantOrderRow[]>
    countByStatus(range?: { from: Date; to: Date }): Promise<Record<string, number>>
    salesSummary(from: Date, to: Date): Promise<AssistantSalesSummary>
  }
  products: {
    lowStock(threshold: number, limit: number): Promise<Array<{ id: string | null; name: string; available: number }>>
    /** Productos sin ninguna variante con precio mayor que cero (fase E). */
    unpriced(limit: number): Promise<{ items: Array<{ id: string; name: string; status: string; variantCount: number }>; total: number }>
    /** Productos sin IVA configurado (tax_rate ausente o no numérico). */
    untaxed(limit: number): Promise<{ items: Array<{ id: string; name: string; status: string }>; total: number }>
    /** Productos con IVA configurado (tax_rate numérico, 0 % incluido), en orden alfabético. */
    taxed(limit: number): Promise<{ items: Array<{ id: string; name: string; status: string; taxRate: number }>; total: number }>
    search(term: string, limit: number): Promise<AssistantProductRow[]>
  }
  categories: {
    /** Categorías en orden alfabético (activas e inactivas) con su número de productos. */
    list(limit: number): Promise<{ items: Array<{ id: string; name: string; status: string; productCount: number }>; total: number }>
  }
  initiatives: {
    list(userId: string, keys: readonly PermissionId[], limit: number): Promise<LumiInitiative[]>
  }
  notifications: {
    countUnread(userId: string): Promise<number>
    recentUnread(userId: string, limit: number): Promise<Array<{ title: string; createdAt: string }>>
  }
  /** Módulo de música del asistente. Sin puerto (asistente sin configurar o pruebas): no disponible. */
  music?: LumiMusicPort
  /** Equipos de escritorio (Lumia Desktop Agent). Sin puerto: el agente no está activado. */
  desktop?: LumiDesktopPort
}

/** Equipo del usuario tal como lo ve el chat. */
export interface LumiDesktopDevice {
  id: string
  name: string
  online: boolean
  paused: boolean
  /** Operaciones que el equipo anuncia ahora mismo (`browser.navigate`, `desktop.click`…). */
  operations: readonly string[]
}

/** Resultado de una operación ejecutada en un equipo (ya verificada por el agente). */
export interface LumiDesktopOutcome {
  /** completed | unverified | failed | rejected | cancelled | timed_out */
  status: string
  result: Record<string, unknown> | null
  error: { code: string; message: string } | null
}

/** Confirmación pendiente de una acción del equipo, tal como la ve el chat. */
export interface LumiDesktopConfirmation {
  /** Identificador de la acción pendiente: la respuesta con botón solo confirma esta. */
  id: string
  /** Qué se hará («abrir https://…», «pulsar «Enviar» en example.com»). */
  summary: string
  device: string
  /** Alcance de «no volver a preguntar» («abrir páginas de example.com»). */
  scope: string
  expiresAt: string
}

/** Aprobación recordada: «no volver a preguntar» para un tipo de acción en un destino. */
export interface LumiDesktopApproval {
  deviceId: string
  /** open_page | click_page | type_page | click_app | type_app */
  kind: string
  /** Sitio (host) o aplicación. */
  target: string
}

export interface LumiDesktopPort {
  devices(userId: string): Promise<LumiDesktopDevice[]>
  /** Ordena una operación con los permisos del usuario (el Server firma y autoriza). */
  execute(input: {
    userId: string
    permissionKeys: readonly PermissionId[]
    deviceId: string
    operation: string
    args: Record<string, unknown>
  }): Promise<LumiDesktopOutcome>
  isApproved(userId: string, approval: LumiDesktopApproval): Promise<boolean>
  approve(userId: string, approval: LumiDesktopApproval): Promise<void>
  /** Acción esperando «sí» / «no» (caduca sola). Sustituye a la anterior del usuario. */
  savePending(
    userId: string,
    payload: Record<string, string>,
    summary: string,
  ): Promise<{ id: string; expiresAt: Date }>
  /**
   * Toma (y borra) la acción pendiente vigente, o null. Solo una respuesta puede consumirla. Con
   * `id`, solo esa acción (botones de la tarjeta de confirmación).
   */
  takePending(userId: string, id?: string): Promise<Record<string, string> | null>
}

/**
 * Resultado de un comando de música (POST /music/commands del asistente):
 *  - `done`: el asistente respondió; `text` es determinista y se muestra tal cual (`ok` false = no se pudo).
 *  - `disabled`: el módulo está apagado (MUSIC_ENABLED=false, el asistente responde 404).
 *  - `unavailable`: el asistente no responde, tardó demasiado o respondió algo inesperado.
 *  - `rejected`: el asistente rechazó los argumentos (422).
 */
export type LumiMusicCommandResult =
  | { status: 'done'; ok: boolean; text: string; error: string | null; state: LumiMusicState | null }
  | { status: 'disabled' }
  | { status: 'unavailable' }
  | { status: 'rejected' }

/** Estado del reproductor (GET /music/state del asistente). */
export type LumiMusicStateResult = { status: 'done'; state: LumiMusicState } | { status: 'disabled' } | { status: 'unavailable' }

/** Argumentos de un comando: texto (búsqueda, salida) o entero (volumen, posición). */
export type LumiMusicArgs = Readonly<Record<string, string | number>>

export interface LumiMusicPort {
  command(userId: string, tool: string, args: LumiMusicArgs): Promise<LumiMusicCommandResult>
  state(userId: string): Promise<LumiMusicStateResult>
}

/** Pista tal como la describe el asistente. Metadatos reales de YouTube; los que no hay, null. */
export interface LumiMusicTrack {
  videoId: string
  title: string
  artist: string | null
  album: string | null
  durationSeconds: number | null
  /** Miniatura pública de YouTube (https://i.ytimg.com/…). */
  thumbnailUrl: string | null
  /** Página del vídeo en YouTube. */
  url: string | null
  source: 'youtube'
}

/**
 * Estado real del reproductor del servidor de música. `playing` solo cuando el motor confirmó audio;
 * `loading` mientras arranca. No incluye nombres de dispositivos del host.
 */
export interface LumiMusicState {
  status: 'idle' | 'loading' | 'playing' | 'paused' | 'stopped' | 'error'
  /** Cambia con cada pista nueva o al detener. */
  generation: number
  current: LumiMusicTrack | null
  upcoming: LumiMusicTrack[]
  positionSeconds: number
  durationSeconds: number | null
  volume: number
  output: { mode: 'aux' | 'bluetooth'; active: boolean }
  error: string | null
  /** Modos de reproducción: los aplica el asistente al acabar cada pista. */
  shuffle: boolean
  repeatMode: 'off' | 'one' | 'all'
  autoplay: boolean
  /** Sube con cada cambio visible del estado. */
  version: number
  /** Momento del estado (ms desde epoch) en el asistente; null si no lo indicó. */
  updatedAt: number | null
}

/** Descubrir música: relacionadas reales (Mix de YouTube) y más del mismo artista. */
export interface LumiMusicDiscovery {
  seed: LumiMusicTrack | null
  tracks: LumiMusicTrack[]
  artistTracks: LumiMusicTrack[]
  artists: Array<{ name: string; tracks: number }>
}

/** Lecturas del módulo de música (recomendaciones, historial, búsqueda). */
export type LumiMusicReadResult<T> = { status: 'done'; data: T } | { status: 'disabled' } | { status: 'unavailable' }

export interface LumiToolContext {
  userId: string
  permissionKeys: readonly PermissionId[]
  now: Date
  timezone: string
  deps: LumiToolDeps
}

/** Entidad que una respuesta deja "abierta" para el turno siguiente ("¿y sus pagos?"). */
export interface LumiEntityRef {
  kind: 'order' | 'product'
  /** Referencia del pedido o nombre del producto, tal como se muestra. Nunca datos de clientes. */
  label: string
}

export interface LumiMusicCandidate {
  id: string // YouTube video ID
  title: string
  artist: string
  duration: number
  thumbnailUrl: string | null
  type: 'song' | 'live' | 'cover' | 'remix' | 'official' | 'unknown'
}

export interface LumiMusicCandidates {
  conversationId: string
  queryId: string
  query: string
  candidates: LumiMusicCandidate[]
  expiresAt: Date
}

export interface LumiToolResult {
  /** Respuesta lista para mostrar (también se guarda en el historial). */
  text: string
  /** Filas leídas, para el indicador de actividad del chat. */
  rows: number
  /** Si la respuesta trata de una sola entidad, queda como contexto del turno siguiente. */
  entity?: LumiEntityRef
  /**
   * Registros y módulos de los que salen los datos, con sus ids reales. El chat los muestra como
   * accesos (icono de ojo, enlace al módulo) y se guardan con el mensaje en el historial.
   */
  references?: LumiReference[]
  /** Estado del reproductor tras un comando de música: el chat lo muestra como reproductor. */
  music?: LumiMusicState
  /** Candidatos de música cuando la confianza es media (0.72-0.87): el usuario selecciona uno. */
  musicCandidates?: LumiMusicCandidates
  /** Acción en un equipo esperando confirmación: el chat puede mostrar botones (fase 5). */
  /**
   * Acción del equipo esperando respuesta. Lumia Admin la muestra como tarjeta con «Sí» / «No» y
   * la casilla «no volver a preguntar» (solo aplica al «Sí»).
   */
  confirmation?: LumiDesktopConfirmation
}

/**
 * Módulos de la tienda. El selector indica a cuál se refiere una petición; cuando no hay
 * herramienta, el módulo permite registrar la capacidad que falta donde corresponde.
 */
export const LUMI_MODULES = [
  'productos',
  'inventario',
  'pedidos',
  'pagos',
  'ventas',
  'clientes',
  'promociones',
  'banners',
  'categorias',
  'resenas',
  'produccion',
  'usuarios',
  'configuracion',
  'recordatorios',
  'notificaciones',
  'iniciativas',
  'musica',
  /** Equipos de escritorio del usuario (Lumia Desktop Agent). */
  'equipo',
] as const
export type LumiModule = (typeof LUMI_MODULES)[number]

/** Tipo de un argumento tal como lo ve el modelo: texto, entero, booleano o lista cerrada. */
export type LumiSelectorArgKind = 'str' | 'int' | 'bool' | readonly string[]

export interface LumiSelectorArg {
  name: string
  kind: LumiSelectorArgKind
  required?: boolean
  description?: string
}

/** Lo que construye `fromArgs`: la entrada validada, o los datos obligatorios que faltan. */
export type LumiSelectorBuild<I> = { input: I } | { missing: string[] }

/**
 * Cómo ve una herramienta el selector (etapa 2). El modelo solo PROPONE la herramienta y sus
 * argumentos; `fromArgs` (Server) construye la entrada: los valores cerrados (periodos, estados)
 * salen del mensaje, nunca del modelo.
 */
export interface LumiToolSelector<I> {
  description: string
  module: LumiModule
  args: readonly LumiSelectorArg[]
  /** Pregunta al usuario cuando falta un dato obligatorio. */
  ask?: string
  fromArgs(
    args: Readonly<Record<string, unknown>>,
    normalized: string,
    ctx: Pick<LumiToolContext, 'now' | 'timezone'>,
  ): LumiSelectorBuild<I>
}

export interface LumiTool<I> {
  name: LumiToolName
  /**
   * Clave de la capacidad en `lumi_capabilities` (fase E). Con ella el Server sabe que la capacidad
   * está implementada; si está habilitada lo decide la base de datos, no el código.
   */
  capabilityKey: string
  /**
   * Solo las herramientas anteriores a la fase E: al migrar se dan de alta habilitadas para no
   * cambiar el comportamiento. Una herramienta nueva NO lo declara y arranca deshabilitada.
   */
  enabledByDefault?: true
  /** Etiqueta corta para el chat ("Consultando pedidos"). */
  label: string
  /** Capacidad y frase de ejemplo, para el prompt de capacidades y la ayuda. */
  capability: string
  example: string
  /** null = cualquier usuario con lumi.use. */
  permission: PermissionId | null
  /** Regla determinista: devuelve la entrada validada o null si el mensaje no es para esta herramienta. */
  match(normalized: string, original: string, ctx: Pick<LumiToolContext, 'now' | 'timezone'>): I | null
  run(ctx: LumiToolContext, input: I): Promise<LumiToolResult>
  /** Sin `selector`, la herramienta solo se usa por reglas (etapa 1). */
  selector?: LumiToolSelector<I>
  /**
   * Herramienta de un módulo externo (la música del asistente). Diferencias con las de datos:
   *  - El selector solo la ve quien tiene su permiso (no es una capacidad de la tienda que falte).
   *  - Su texto es la respuesta final: nunca pasa al modelo para «explicarla».
   *  - `effect: 'control'` cambia algo fuera del Server (lo que suena): las pruebas no la ejecutan.
   */
  external?: { effect: 'read' | 'control' }
}

/** Límite de caracteres de una respuesta de herramienta (el historial acepta hasta 8000). */
export const TOOL_TEXT_MAX_CHARS = 3500

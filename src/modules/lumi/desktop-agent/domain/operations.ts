import { z } from 'zod'
import { PERMISSION_REGISTRY, type PermissionId } from '../../../../common/permissions/registry.js'

/**
 * Operaciones que el Server puede ordenar a un agente (fase 2: navegador; fase 3: aplicaciones).
 * Nada fuera de este catálogo se firma: no existe "ejecutar comando", JavaScript arbitrario,
 * lanzar o cerrar aplicaciones, coordenadas, portapapeles ni capturas. Los esquemas replican los
 * del agente (crates/engine-browser y crates/engine-desktop) y rechazan campos desconocidos.
 *
 * El agente aplica además su propia política local, que el Server no puede ampliar: nunca
 * automatiza terminales, herramientas del sistema, navegadores (solo su perfil aislado), gestores
 * de contraseñas, acceso remoto ni a sí mismo.
 */

const ref = z.string().regex(/^@?e\d{1,6}$/, 'expected a snapshot ref such as e12')

const httpUrl = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value)
      return (
        (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
      )
    } catch {
      return false
    }
  }, 'only http(s) URLs without credentials')

const empty = z.object({}).strict()

/** Ref de un snapshot de escritorio: `@<snapshot>:e<n>`. */
const desktopRef = z
  .string()
  .regex(/^@?[a-z0-9]{4,32}:e\d{1,6}$/, 'expected a desktop snapshot ref such as @s8f3k2p9:e12')

/** Nombre de aplicación tal como lo lista `desktop.list_applications` (sin rutas ni opciones). */
const appName = z
  .string()
  .min(1)
  .max(128)
  .regex(/^(?!-)[\p{L}\p{N} ._()+-]+$/u, 'invalid application name')

const windowId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^(?!-)[A-Za-z0-9_:.-]+$/, 'invalid window id')

/**
 * Teclas permitidas: navegación y edición. Nada que abra diálogos de ejecución, cierre o cambie de
 * ventana o bloquee la sesión. Coincide con crates/engine-desktop/src/policy.rs.
 */
export const DESKTOP_ALLOWED_KEYS = [
  'enter',
  'return',
  'tab',
  'shift+tab',
  'escape',
  'space',
  'backspace',
  'delete',
  'up',
  'down',
  'left',
  'right',
  'home',
  'end',
  'pageup',
  'pagedown',
  'ctrl+a',
  'ctrl+c',
  'ctrl+x',
  'ctrl+v',
  'ctrl+z',
  'ctrl+y',
  'ctrl+f',
] as const

export interface DesktopOperation {
  /** Permiso que necesita quien ordena la operación (además de ser dueño del equipo). */
  permission: PermissionId
  args: z.ZodTypeAny
  /** Resumen sin datos privados para el registro (nunca valores escritos ni contenido de páginas). */
  summarize: (args: Record<string, unknown>) => Record<string, unknown>
}

/** Archivos (fase 6): carpeta autorizada (id opaco del agente) y nombres relativos. */
const rootId = z
  .string()
  .regex(/^root_[a-f0-9]{12}$/, 'expected a folder id such as root_0123456789ab')
const fileName = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (v) =>
      v !== '.' &&
      v !== '..' &&
      !/[\\/:*?"<>|]/.test(v) &&
      [...v].every((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) !== 0x7f),
    'invalid file name',
  )
const relativePath = z
  .string()
  .max(1024)
  .refine(
    (v) => v === '' || v.split('/').every((part) => fileName.safeParse(part).success),
    'invalid relative path',
  )

export const MAX_FILE_BYTES = 100 * 1024 * 1024
export const TRANSFER_CHUNK_BYTES = 256 * 1024
/** Las transferencias pueden durar más que cualquier operación interactiva. */
export const TRANSFER_MAX_TIMEOUT_MS = 15 * 60_000

/** Solo la extensión: el nombre de un archivo puede ser privado y el registro dura 180 días. */
function extensionOf(value: unknown): string | null {
  const match = /\.([A-Za-z0-9]{1,10})$/.exec(String(value ?? ''))
  return match ? match[1]!.toLowerCase() : null
}

const READ = PERMISSION_REGISTRY.DESKTOP_BROWSER_READ
const CONTROL = PERMISSION_REGISTRY.DESKTOP_BROWSER_CONTROL
const APPS_READ = PERMISSION_REGISTRY.DESKTOP_APPS_READ
const APPS_CONTROL = PERMISSION_REGISTRY.DESKTOP_APPS_CONTROL
const FILES_READ = PERMISSION_REGISTRY.DESKTOP_FILES_READ
const FILES_WRITE = PERMISSION_REGISTRY.DESKTOP_FILES_WRITE

function originOf(value: unknown): string | null {
  try {
    return new URL(String(value)).origin
  } catch {
    return null
  }
}

export const DESKTOP_OPERATIONS: Record<string, DesktopOperation> = {
  'browser.discover': { permission: READ, args: empty, summarize: () => ({}) },
  'browser.snapshot': {
    permission: READ,
    args: z.object({ interactive: z.boolean().optional() }).strict(),
    summarize: (a) => ({ interactive: a.interactive ?? true }),
  },
  'browser.tabs.list': { permission: READ, args: empty, summarize: () => ({}) },
  'browser.navigate': {
    permission: CONTROL,
    args: z.object({ url: httpUrl }).strict(),
    // Solo el origen: la ruta o la query pueden llevar datos personales o tokens.
    summarize: (a) => ({ origin: originOf(a.url) }),
  },
  'browser.click': {
    permission: CONTROL,
    args: z.object({ ref }).strict(),
    summarize: (a) => ({ ref: a.ref }),
  },
  'browser.fill': {
    permission: CONTROL,
    args: z.object({ ref, value: z.string().max(10_000) }).strict(),
    summarize: (a) => ({ ref: a.ref, value_length: String(a.value ?? '').length }),
  },
  'browser.scroll': {
    permission: CONTROL,
    args: z
      .object({
        direction: z.enum(['up', 'down', 'left', 'right']),
        pixels: z.number().int().min(1).max(10_000).optional(),
      })
      .strict(),
    summarize: (a) => ({ direction: a.direction, pixels: a.pixels ?? 600 }),
  },
  'browser.close_session': { permission: CONTROL, args: empty, summarize: () => ({}) },

  'desktop.status': { permission: APPS_READ, args: empty, summarize: () => ({}) },
  'desktop.list_applications': { permission: APPS_READ, args: empty, summarize: () => ({}) },
  'desktop.list_windows': { permission: APPS_READ, args: empty, summarize: () => ({}) },
  'desktop.snapshot': {
    permission: APPS_READ,
    args: z
      .object({
        app: appName,
        window_id: windowId.optional(),
        interactive: z.boolean().optional(),
        skeleton: z.boolean().optional(),
        root: desktopRef.optional(),
      })
      .strict(),
    summarize: (a) => ({
      app: a.app,
      interactive: a.interactive ?? true,
      skeleton: a.skeleton ?? false,
    }),
  },
  'desktop.get_value': {
    permission: APPS_READ,
    args: z.object({ ref: desktopRef }).strict(),
    summarize: (a) => ({ ref: a.ref }),
  },
  'desktop.click': {
    permission: APPS_CONTROL,
    args: z.object({ ref: desktopRef }).strict(),
    summarize: (a) => ({ ref: a.ref }),
  },
  'desktop.set_value': {
    permission: APPS_CONTROL,
    args: z.object({ ref: desktopRef, value: z.string().max(10_000) }).strict(),
    summarize: (a) => ({ ref: a.ref, value_length: String(a.value ?? '').length }),
  },
  'desktop.press_key': {
    permission: APPS_CONTROL,
    args: z
      .object({
        app: appName,
        key: z
          .string()
          .transform((k) => k.trim().toLowerCase().replace(/\s+/g, ''))
          .pipe(z.enum(DESKTOP_ALLOWED_KEYS)),
      })
      .strict(),
    summarize: (a) => ({ app: a.app, key: a.key }),
  },
  'files.roots': { permission: FILES_READ, args: empty, summarize: () => ({}) },
  'files.list': {
    permission: FILES_READ,
    args: z.object({ root: rootId, path: relativePath.optional() }).strict(),
    summarize: (a) => ({ root: a.root }),
  },
  'files.download': {
    permission: FILES_READ,
    args: z.object({ root: rootId, path: relativePath.refine((v) => v !== '') }).strict(),
    summarize: (a) => ({ root: a.root, ext: extensionOf(a.path) }),
  },
  'files.upload': {
    permission: FILES_WRITE,
    args: z
      .object({
        root: rootId,
        dir: relativePath.default(''),
        name: fileName,
        size: z.number().int().min(0).max(MAX_FILE_BYTES),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    summarize: (a) => ({ root: a.root, ext: extensionOf(a.name), size: a.size }),
  },
}

export type DesktopOperationName = keyof typeof DESKTOP_OPERATIONS

export function isDesktopOperation(name: string): name is DesktopOperationName {
  return Object.prototype.hasOwnProperty.call(DESKTOP_OPERATIONS, name)
}

/** Operaciones con transferencia de datos (tiempo máximo mayor y canal `transfer.*`). */
export const TRANSFER_OPERATIONS: readonly string[] = ['files.download', 'files.upload']

export const MIN_TIMEOUT_MS = 1_000
export const MAX_TIMEOUT_MS = 120_000
export const DEFAULT_TIMEOUT_MS = 30_000
/** Validez del grant: cubre la entrega y la cola local, no la duración de la ejecución. */
export const GRANT_LIFETIME_SECONDS = 120

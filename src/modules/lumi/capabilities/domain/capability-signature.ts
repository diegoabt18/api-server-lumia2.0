import { plainText } from '../../selector/selector-text.js'

/**
 * Firma de una petición para agrupar las que piden lo mismo con otras palabras. Determinista y sin
 * modelo: palabras clave del mensaje y de `need`, sin palabras vacías, con sinónimos y raíz común.
 */

/** Palabras que no dicen QUÉ se pide: artículos, verbos de petición, cortesía y nombres genéricos. */
const STOPWORDS = new Set(
  (
    'a al algo alguna alguno algunas algunos ante como con cual cuales cuando cuanta cuantas cuanto cuantos de del ' +
    'donde el ella ellos en entre es esa ese eso esta estan estas este esto estos favor hay la las le les lo los me ' +
    'mi mis muy nos o para pero por porfa porque que se si son su sus te tiene tienen tengo tu un una unas unos y ya ' +
    'busca buscar buscame dame dime decir decirme di dar explica explicame explicar explicarme muestra muestrame ' +
    'mostrar menciona mencionalos enumera ' +
    'puedes puedo podrias quiero necesito quisiera ver saber hacer hace sirve lista listado todos todas todo toda ' +
    'cada mas menos estado datos informacion ' +
    'producto productos pedido pedidos orden ordenes articulo articulos item items cosa cosas lumi tienda'
  ).split(' '),
)

/**
 * Palabras que cambian el sentido, o que solo nombran la entidad, pero no bastan solas para decir
 * que dos peticiones son la misma ("este usuario está activo" y "el contacto de este usuario").
 */
const MODIFIERS = new Set(['sin', 'activo', 'negativo', 'exportar', 'usuario'])

/**
 * Sinónimos base → forma canónica. Escritos a mano para el dominio de la tienda; en una fase
 * posterior el panel podrá ampliarlos.
 */
const SYNONYMS: Record<string, string> = {
  pagina: 'pagina', paginas: 'pagina', pantalla: 'pagina', pantallas: 'pagina', vista: 'pagina', seccion: 'pagina', modulo: 'pagina', opcion: 'pagina', opciones: 'pagina',
  resena: 'resena', resenas: 'resena', opinion: 'resena', opiniones: 'resena', calificacion: 'resena',
  calificaciones: 'resena', comentario: 'resena', comentarios: 'resena', valoracion: 'resena', valoraciones: 'resena',
  descarga: 'exportar', descargar: 'exportar', descargame: 'exportar', exporta: 'exportar', exportame: 'exportar',
  exportar: 'exportar', bajar: 'exportar', excel: 'exportar', csv: 'exportar', pdf: 'exportar',
  mala: 'negativo', malas: 'negativo', malo: 'negativo', malos: 'negativo', negativa: 'negativo',
  negativas: 'negativo', negativos: 'negativo',
  whatsapp: 'contacto', whatsap: 'contacto', wasap: 'contacto', wasa: 'contacto', telefono: 'contacto',
  celular: 'contacto', correo: 'contacto', email: 'contacto', contacto: 'contacto', contactos: 'contacto',
  usuario: 'usuario', usuarios: 'usuario', cuenta: 'usuario', cuentas: 'usuario',
  vencida: 'vencer', vencidas: 'vencer', vencido: 'vencer', vencidos: 'vencer', vencidad: 'vencer',
  caducada: 'vencer', caducadas: 'vencer', expirada: 'vencer', expiradas: 'vencer', vencer: 'vencer',
  banner: 'banner', baner: 'banner', banners: 'banner', baners: 'banner',
  precio: 'precio', precios: 'precio', valor: 'precio', valores: 'precio',
  iva: 'impuesto', impuesto: 'impuesto', impuestos: 'impuesto',
  activo: 'activo', activos: 'activo', activa: 'activo', activas: 'activo', habilitado: 'activo',
  comprobante: 'comprobante', factura: 'comprobante', recibo: 'comprobante', soporte: 'comprobante',
  falta: 'sin', faltan: 'sin', ningun: 'sin', ninguna: 'sin', vacio: 'sin', vacia: 'sin',
}

/** Raíz: la forma canónica, o los 5 primeros caracteres ("categorias" y "categoria" → "categ"). */
function stem(word: string): string {
  const canonical = SYNONYMS[word]
  if (canonical) return canonical
  return word.length > 5 ? word.slice(0, 5) : word
}

export function capabilityKeywords(...texts: string[]): string[] {
  const out = new Set<string>()
  for (const text of texts) {
    for (const word of plainText(text).split(' ')) {
      if (word.length < 3 && word !== 'iva') continue
      if (/^\d+$/.test(word) || STOPWORDS.has(word)) continue
      out.add(stem(word))
    }
  }
  return [...out].sort()
}

export function capabilitySignature(module: string, keywords: readonly string[]): string {
  return `${module}:${keywords.join(' ')}`
}

export type GroupMatch = 'same' | 'possible' | 'none'

/**
 * Compara dos conjuntos de palabras clave.
 * - `same`: Jaccard ≥ 0,6, o uno contiene al otro y comparten al menos dos palabras.
 * - `possible`: comparten al menos la mitad del menor; el administrador decide si fusionar.
 * Compartir solo modificadores ("sin", "exportar") nunca basta, salvo que sean exactamente las mismas palabras.
 */
export function compareKeywords(a: readonly string[], b: readonly string[]): { match: GroupMatch; score: number } {
  if (a.length === 0 || b.length === 0) return { match: 'none', score: 0 }
  const setB = new Set(b)
  const shared = a.filter((w) => setB.has(w))
  const union = new Set([...a, ...b]).size
  // Exactamente las mismas palabras ("descarga los productos" / "exportar productos"): la misma petición.
  if (shared.length === union) return { match: 'same', score: 1 }
  if (!shared.some((w) => !MODIFIERS.has(w))) return { match: 'none', score: 0 }
  const jaccard = shared.length / union
  const overlap = shared.length / Math.min(a.length, b.length)
  if (jaccard >= 0.6 || (overlap === 1 && shared.length >= 2)) return { match: 'same', score: jaccard }
  if (overlap >= 0.5) return { match: 'possible', score: jaccard }
  return { match: 'none', score: jaccard }
}

/** Clave legible y única: "resenas-negativo-resena-3f9a1c". */
export function capabilityKey(module: string, keywords: readonly string[], suffix: string): string {
  const words = keywords.slice(0, 4).join('-')
  return `${module}-${words || 'peticion'}-${suffix}`.replace(/[^a-z0-9-]/g, '').slice(0, 80)
}

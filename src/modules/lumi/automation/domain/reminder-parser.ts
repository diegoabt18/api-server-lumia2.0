/**
 * Intérprete de instrucciones de recordatorios en español, por reglas. Devuelve una operación
 * estructurada o una pregunta cuando falta un dato indispensable (hora o franja AM/PM).
 * No llama a ningún modelo: las frases libres que no encajan se devuelven como `none`.
 */
import { zonedDayTime } from './schedule.js'

export type AutomationCommand =
  | { kind: 'none' }
  | { kind: 'ask'; question: string }
  | { kind: 'unsupported'; reason: string }
  | {
      kind: 'create_routine'
      title: string
      description: string
      taskKind: 'initiative_review' | 'reminder'
      time: string
      followUpTime: string | null
    }
  | { kind: 'create_reminder'; title: string; runAt: Date }
  | { kind: 'mark_reviewed' }
  | { kind: 'suppress_today' }
  | { kind: 'set_followup_time'; time: string }
  | { kind: 'list' }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'delete'; target: 'initiative_review' | null }

export function normalizeText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

const NUMBER_WORDS: Record<string, number> = {
  un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
}

interface FoundTime {
  /** HH:mm en 24 h, o null si la franja AM/PM es ambigua. */
  time: string | null
}

const TIME_RE =
  /\blas? (\d{1,2})(?::(\d{2}))?\b(?:\s+(?:de la|de las|en la|en las))?\s*(manana|tarde|noche|a\.\s?m\.?|p\.\s?m\.?|am|pm)?/g

/** Extrae horas de un texto normalizado. Sin franja y entre 1 y 12, la hora es ambigua. */
export function findTimes(normalized: string): FoundTime[] {
  const found: FoundTime[] = []
  for (const match of normalized.matchAll(TIME_RE)) {
    let hour = Number(match[1])
    const minute = match[2] ? Number(match[2]) : 0
    const period = match[3] ?? ''
    if (hour > 23 || minute > 59) {
      found.push({ time: null })
      continue
    }
    if (/^(tarde|noche|p)/.test(period)) {
      if (hour < 12) hour += 12
    } else if (/^(manana|a|am)/.test(period)) {
      if (hour === 12) hour = 0
    } else if (hour >= 1 && hour <= 12) {
      found.push({ time: null })
      continue
    }
    found.push({ time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` })
  }
  return found
}

/**
 * Palabras de datos de la tienda. Una frase que habla de pedidos, productos o ventas no es una orden
 * sobre las rutinas de Lumi aunque contenga "revisión", "tareas" o "cancela": va al modelo o a las
 * herramientas. Solo se acepta como orden si además nombra de forma explícita una rutina o un recordatorio.
 */
const BUSINESS_SUBJECT =
  /\b(pedidos?|ordenes?|productos?|produccion|clientes?|promociones?|ventas?|inventario|stock|categorias?|envios?|pagos?|facturas?|cupones?|banners?|recetas?|materiales?|proveedores?)\b/
const EXPLICIT_AUTOMATION_OBJECT =
  /\b(rutinas?|recordatorios?|segundo aviso|avisos de lumi|revision diaria|revision de (las )?iniciativas)\b/

/** ¿La frase trata de datos de la tienda sin nombrar explícitamente una rutina o recordatorio? */
export function isAboutBusinessData(normalized: string): boolean {
  return BUSINESS_SUBJECT.test(normalized) && !EXPLICIT_AUTOMATION_OBJECT.test(normalized)
}

/** Respuestas que confirman una acción pendiente ("sí, elimínala"). Solo cuentan si hay una pendiente. */
export function isConfirmation(normalized: string): boolean {
  return /^(si|confirmo|confirmar|adelante|hazlo)([ ,.!]+(eliminala|eliminalo|borrala|borralo|elimina|borra|confirmo|adelante|por favor|hazlo))*[ .!]*$/.test(
    normalized,
  )
}

/** Respuestas que descartan una acción pendiente. Solo cuentan si hay una pendiente. */
export function isRejection(normalized: string): boolean {
  return /^(no|cancela|cancelar|mejor no|no la elimines|no lo elimines|dejala|dejalo)([ ,.!]+(gracias|mejor no|cancela|dejala|dejalo))*[ .!]*$/.test(
    normalized,
  )
}

const UNSUPPORTED_EVENT_REMINDER =
  'Por ahora solo programo recordatorios con fecha y hora (por ejemplo: «Recuérdame mañana a las 9 de la mañana revisar el stock»). Las alertas de stock bajo y de pedidos atrasados aparecen solas en Iniciativas.'

/** Frases de recordatorio: "recuérdame", "avísame", "ponme una alarma", "agenda un recordatorio"... */
const REMINDER_TRIGGER =
  /recuerd|avis(a|e)me|recordatorio|\balarma\b|\bponme un aviso\b|\bagendame\b|\bagenda(r)? (un|una) (recordatorio|aviso|alarma)/

const AMBIGUOUS_QUESTION = '¿Esa hora es de la mañana o de la tarde?'
const UNSUPPORTED_PAUSE =
  'Por ahora puedo pausar y reanudar tus recordatorios, pero todavía no programo pausas por días o semanas. ¿Quieres que los pause hasta que los reanudes?'

function cleanTitle(original: string): string {
  // Conserva el texto original (con tildes) quitando la orden y la expresión de hora/fecha.
  const stripped = original
    .replace(
      /^\s*((recu[eé]rdame|recuerda|recu[eé]rdeme|av[ií]same|av[ií]seme)|((p[oó]n(me)?|programa(me)?|crea(me)?|ag[eé]nda(me)?)\s+(una?\s+)?(alarma|recordatorio|aviso)))\s*(para\s+)?/i,
      '',
    )
    .replace(/\b(a las?)\s*\d{1,2}(:\d{2})?\s*(de la (ma[nñ]ana|tarde|noche)|a\.?\s?m\.?|p\.?\s?m\.?)?/gi, '')
    .replace(/\ben (\d+|una|un|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez) horas?\b/gi, '')
    .replace(/\b(hoy|ma[nñ]ana)\b/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,.;:]+|[\s,.;:]+$/g, '')
    // "Ponme una alarma mañana a las 9 para llamar…": tras quitar la fecha queda "para llamar…".
    .replace(/^(para|de)\s+/i, '')
  return stripped.length > 0 ? stripped.slice(0, 120) : 'Recordatorio'
}

/**
 * Interpreta un mensaje. `now` y `timezone` anclan las fechas relativas ("mañana", "en dos horas").
 */
export function parseAutomationCommand(
  message: string,
  now: Date,
  timezone: string,
): AutomationCommand {
  const text = normalizeText(message)
  if (!text) return { kind: 'none' }

  // Las órdenes de gestión (revisar, listar, pausar, reanudar, borrar) no se aplican a frases sobre
  // datos de la tienda: "Cancela la revisión del pedido 1234" no es borrar una rutina.
  const businessData = isAboutBusinessData(text)

  if (!businessData && /como revisad[oa]|ya (las |lo |la )?(revise|he revisado)|marca (la )?revision/.test(text)) {
    return { kind: 'mark_reviewed' }
  }
  if (/hoy no me recuerdes|no me recuerdes (mas )?hoy|no me recuerdes mas/.test(text)) {
    return { kind: 'suppress_today' }
  }
  if (/cambia\w* (el )?segundo (recordatorio|aviso)/.test(text)) {
    const [first] = findTimes(text)
    if (!first) return { kind: 'ask', question: '¿A qué hora quieres el segundo recordatorio?' }
    if (!first.time) return { kind: 'ask', question: AMBIGUOUS_QUESTION }
    return { kind: 'set_followup_time', time: first.time }
  }
  if (!businessData && !/\bresumen\b/.test(text) && /(muestrame|mostrame|muestra|lista|dame).*(rutinas|recordatorios|tareas)|(que|cuales) (rutinas|recordatorios|tareas).*(activ|pendient|tengo)|rutinas activas|recordatorios activos|tareas pendientes/.test(text)) {
    return { kind: 'list' }
  }
  if (!businessData && /\bpausa\w*\b.*(rutina|recordatorio|revision)/.test(text)) {
    if (/durante|una semana|\d+ dias?|(dos|tres|cuatro|cinco|seis|siete) dias?|un dia/.test(text)) {
      return { kind: 'unsupported', reason: UNSUPPORTED_PAUSE }
    }
    return { kind: 'pause' }
  }
  if (!businessData && /(reactiva|reanuda)\w*\b.*(recordatorio|rutina|revision)/.test(text)) return { kind: 'resume' }
  // Borrar exige nombrar el objeto ("la rutina", "el recordatorio", "la revisión diaria"). La ejecución
  // siempre pide confirmación (ver AutomationCommands).
  if (
    !businessData &&
    /(elimina|borra|quita|cancela)\w*\b.*\b(rutinas?|recordatorios?|revision diaria|revision de (las )?iniciativas|segundo aviso)\b/.test(text)
  ) {
    return { kind: 'delete', target: /iniciativ|revision diaria/.test(text) ? 'initiative_review' : null }
  }

  const isRoutine = /todos los dias|cada dia/.test(text)
  if (isRoutine) {
    const times = findTimes(text)
    if (times.length === 0) return { kind: 'ask', question: '¿A qué hora quieres el recordatorio diario?' }
    const [primary, second] = times
    if (!primary!.time) return { kind: 'ask', question: AMBIGUOUS_QUESTION }
    let followUpTime: string | null = null
    if (second && /record|avis/.test(text)) {
      if (!second.time) return { kind: 'ask', question: '¿A qué hora quieres el segundo recordatorio, de la mañana o de la tarde?' }
      followUpTime = second.time
    }
    const initiative = /iniciativ/.test(text)
    return {
      kind: 'create_routine',
      title: initiative ? 'Revisar iniciativas pendientes' : 'Recordatorio diario',
      description: message.trim().slice(0, 300),
      taskKind: initiative ? 'initiative_review' : 'reminder',
      time: primary!.time,
      followUpTime,
    }
  }

  if (REMINDER_TRIGGER.test(text)) {
    // "Avísame cuando se agote X" es un aviso por evento: no se programa como recordatorio con hora.
    if (/\bcuando (se )?(agote|acabe|termine|llegue|haya|baje|suba|entre|pague|venda)/.test(text) && findTimes(text).length === 0) {
      return { kind: 'unsupported', reason: UNSUPPORTED_EVENT_REMINDER }
    }
    const relative = /en (\d+|una|un|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez) horas?/.exec(text)
    if (relative) {
      const raw = relative[1]!
      const hours = /^\d+$/.test(raw) ? Number(raw) : NUMBER_WORDS[raw] ?? 0
      if (hours > 0) {
        return {
          kind: 'create_reminder',
          title: cleanTitle(message),
          runAt: new Date(now.getTime() + hours * 3_600_000),
        }
      }
    }

    const [time] = findTimes(text)
    // "de la mañana" indica franja horaria, no el día de mañana.
    const dateText = text.replace(/de la manana/g, '')
    const hasTomorrow = /\bmanana\b/.test(dateText)
    const hasToday = /\bhoy\b/.test(dateText)
    if (!time && !hasTomorrow && !hasToday) {
      return { kind: 'ask', question: '¿Para qué día y hora quieres el recordatorio?' }
    }
    if (!time) return { kind: 'ask', question: '¿A qué hora quieres el recordatorio?' }
    if (!time.time) return { kind: 'ask', question: AMBIGUOUS_QUESTION }

    let dayOffset = hasTomorrow ? 1 : 0
    let runAt = zonedDayTime(now, timezone, dayOffset, time.time)
    if (!hasTomorrow && !hasToday && runAt.getTime() <= now.getTime()) {
      dayOffset = 1
      runAt = zonedDayTime(now, timezone, dayOffset, time.time)
    }
    return { kind: 'create_reminder', title: cleanTitle(message), runAt }
  }

  return { kind: 'none' }
}

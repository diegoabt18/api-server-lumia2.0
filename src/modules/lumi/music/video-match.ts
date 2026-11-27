import { levenshteinSimilarity } from '../selector/fuzzy-matcher.js'
import { plainText } from '../selector/selector-text.js'

/**
 * Coincidencia entre lo que pide la persona («/music linkin park numb») y el nombre accesible de un
 * resultado de YouTube («Numb (Official Music Video) [4K UPGRADE] – Linkin Park 3 minutos y 8
 * segundos»).
 *
 * Se separa la interpretación de la consulta (términos y, si la consulta lo dice, título y artista)
 * de la coincidencia con cada resultado. Un resultado es candidato si encaja al menos el 75 % de lo
 * pedido, en cualquier orden, aceptando palabras incompletas («num» → «numb») y errores de
 * escritura en palabras largas, nunca parecidos entre palabras cortas («numb» ≠ «dumb»). El orden
 * combina cobertura, precisión (palabras de más), correspondencia artista-título y tipo de
 * contenido. Solo se usan los nombres reales de los resultados: nada se inventa.
 *
 * La comparación anterior (Jaro-Winkler sobre el nombre completo y artista solo con «de») daba
 * 0,66 al vídeo oficial de «linkin park numb», por debajo del umbral, y la búsqueda no devolvía
 * ningún vídeo aunque YouTube mostrara decenas.
 */

/** Palabras que no identifican la canción. */
const STOPWORDS = new Set([
  'de',
  'del',
  'la',
  'el',
  'los',
  'las',
  'y',
  'by',
  'the',
  'and',
  'a',
  'ft',
  'feat',
  'featuring',
  'x',
])

/** Tipo de resultado, a partir de su nombre. */
export type VideoKind = 'official' | 'song' | 'lyrics' | 'live' | 'cover' | 'remix' | 'mix'

const MIX = /^mix\b|\bmix\s*:|\bplaylist\b|\blista de reproduccion\b/
const LYRICS = /\b(?:lyrics?|letra|sub(?:titulad[oa]|s?\.?)\s+espanol)\b/
const LIVE = /\b(?:live|en vivo|directo|concierto|concert)\b/
const COVER = /\b(?:cover|karaoke|tribute|tributo|instrumental)\b/
const REMIX = /\b(?:remix|rework|sped up|slowed|nightcore|8d)\b/
const OFFICIAL = /\b(?:official|oficial|topic)\b/

export function videoKind(label: string): VideoKind {
  const text = plainText(label)
  if (MIX.test(text)) return 'mix'
  if (COVER.test(text)) return 'cover'
  if (REMIX.test(text)) return 'remix'
  if (LIVE.test(text)) return 'live'
  if (LYRICS.test(text)) return 'lyrics'
  if (OFFICIAL.test(text)) return 'official'
  return 'song'
}

/** Preferencia para elegir un único vídeo: el oficial antes que una versión. */
export const KIND_RANK: Record<VideoKind, number> = {
  official: 0,
  song: 1,
  lyrics: 2,
  live: 3,
  remix: 4,
  cover: 5,
  mix: 6,
}

/**
 * Palabras que describen la subida, no otra canción («Official Music Video [4K UPGRADE]»): no
 * cuentan como palabras de más. Las que marcan otra versión (lyrics, live, cover, remix) sí.
 */
const DESCRIPTIVE = new Set([
  'official',
  'oficial',
  'music',
  'musica',
  'video',
  'videoclip',
  'clip',
  'audio',
  'hd',
  'hq',
  '4k',
  'upgrade',
  'remaster',
  'remastered',
  'remasterizado',
  'version',
  'full',
  'original',
  'topic',
])

function words(text: string): string[] {
  return plainText(text)
    .split(/[\s:-]+/)
    .filter((w) => w.length > 0 && !STOPWORDS.has(w))
}

/* ───────────────────────── Interpretación de la consulta ───────────────────────── */

/**
 * Lo que la persona pidió, separado de los resultados: los términos y, si la consulta lo dice
 * («numb de linkin park», «numb by linkin park», «linkin park - numb»), qué términos son el título
 * y cuáles el artista. Sin separador no se adivina el papel de cada palabra: decide la
 * correspondencia con cada resultado.
 */
export interface MusicQuery {
  terms: string[]
  title: string[]
  artist: string[]
}

export function interpretMusicQuery(raw: string): MusicQuery {
  const text = plainText(raw)
  const ofArtist = /^(.+?)\s+(?:de|by)\s+(.+)$/.exec(text)
  const dashed = /^(.+?)\s+-\s+(.+)$/.exec(text)
  const title = ofArtist ? words(ofArtist[1]!) : dashed ? words(dashed[2]!) : []
  const artist = ofArtist ? words(ofArtist[2]!) : dashed ? words(dashed[1]!) : []
  return { terms: words(text), title, artist }
}

/* ───────────────────────── Coincidencia con un resultado ───────────────────────── */

/** Mínimo de letras para tratar un término como palabra incompleta («num» → «numb»). */
const PREFIX_MIN = 3
const TYPO_MIN = 5
const TYPO_SIMILARITY = 0.8

/**
 * Cuánto encaja un término con una palabra del resultado: exacto 1; error de escritura en palabras
 * largas 0,9; palabra incompleta (el término es el comienzo de la palabra) 0,8; si no, 0. Nunca se
 * aproximan palabras cortas por parecido: «numb» no es «dumb».
 */
export function termWeight(term: string, word: string): number {
  if (term === word) return 1
  if (
    term.length >= TYPO_MIN &&
    word.length >= TYPO_MIN &&
    levenshteinSimilarity(term, word) >= TYPO_SIMILARITY
  ) {
    return 0.9
  }
  if (term.length >= PREFIX_MIN && word.length > term.length && word.startsWith(term)) return 0.8
  return 0
}

function bestWeight(term: string, found: string[]): number {
  return found.reduce((best, word) => Math.max(best, termWeight(term, word)), 0)
}

/** Partes del nombre separadas por guion («Linkin Park - Numb», «Numb – Linkin Park»). */
function segments(text: string): string[][] {
  return text
    .split(/\s+[-–—|~•]\s+/)
    .map(words)
    .filter((part) => part.length > 0)
}

export interface VideoMatch {
  /** Media de lo que encaja cada término pedido (1 = todos exactos). */
  coverage: number
  /** Parte de las palabras del resultado que corresponden a lo pedido (1 = nada de más). */
  precision: number
  /**
   * Correspondencia artista-título: 1 si la consulta nombra dos partes del resultado (artista y
   * canción) o el título y el artista que dijo la persona coinciden con partes distintas; 0,5 si
   * solo encaja una parte; 0,75 si el nombre no trae partes separadas.
   */
  correspondence: number
  score: number
}

function partHits(terms: string[], part: string[]): number {
  return terms.filter((t) => bestWeight(t, part) > 0).length
}

/** `text`: título y canal del resultado, sin duración ni visualizaciones. */
export function matchVideo(query: string | MusicQuery, text: string): VideoMatch {
  const q = typeof query === 'string' ? interpretMusicQuery(query) : query
  const all = words(text)
  const found = all.filter((w) => !DESCRIPTIVE.has(w) || q.terms.includes(w))
  if (q.terms.length === 0 || found.length === 0) {
    return { coverage: 0, precision: 0, correspondence: 0, score: 0 }
  }
  const coverage = q.terms.reduce((sum, t) => sum + bestWeight(t, found), 0) / q.terms.length
  const precision =
    found.filter((w) => q.terms.some((t) => termWeight(t, w) > 0)).length / found.length

  const parts = segments(text)
  let correspondence = 0.75
  if (parts.length >= 2) {
    if (q.title.length > 0 && q.artist.length > 0) {
      const titlePart = parts.findIndex((p) => partHits(q.title, p) === q.title.length)
      const artistPart = parts.findIndex((p) => partHits(q.artist, p) === q.artist.length)
      correspondence = titlePart >= 0 && artistPart >= 0 && titlePart !== artistPart ? 1 : 0.5
    } else {
      correspondence = parts.filter((p) => partHits(q.terms, p) > 0).length >= 2 ? 1 : 0.5
    }
  }
  const score = 0.6 * coverage + 0.25 * precision + 0.15 * correspondence
  return { coverage, precision, correspondence, score }
}

/**
 * Un resultado es candidato si encaja al menos el 75 % de lo pedido: una palabra abreviada o mal
 * escrita no lo descarta; otra canción del mismo artista (falta el título) sí.
 */
export const CANDIDATE_COVERAGE = 0.75

export function isCandidate(match: VideoMatch): boolean {
  return match.coverage >= CANDIDATE_COVERAGE
}

/** Ajuste del orden por tipo de contenido: el oficial sube, las versiones bajan. */
export const KIND_ADJUST: Record<VideoKind, number> = {
  official: 0.02,
  song: 0,
  lyrics: -0.02,
  live: -0.04,
  remix: -0.05,
  cover: -0.06,
  mix: -1,
}

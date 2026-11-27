import { containmentSimilarity } from '../selector/fuzzy-matcher.js'
import { plainText } from '../selector/selector-text.js'

/**
 * Coincidencia entre lo que pide la persona («/music linkin park numb») y el nombre accesible de un
 * resultado de YouTube («Numb (Official Music Video) [4K UPGRADE] – Linkin Park 3 minutos y 8
 * segundos»).
 *
 * Un resultado es candidato solo si contiene **todas** las palabras pedidas, en cualquier orden
 * (artista y canción se escriben en ambos órdenes y casi nunca con «de»), tolerando errores de
 * escritura en palabras largas («conspirancy» → «conspiracy»), nunca en cortas («numb» ≠ «dumb»).
 * Entre candidatos se prefiere el que tiene menos palabras de más (más preciso).
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

export interface VideoMatch {
  /** Parte de las palabras pedidas que aparecen en el resultado (1 = todas). */
  coverage: number
  /** Parte de las palabras del resultado que son de lo pedido (1 = nada de más). */
  precision: number
  /** 0,7 · cobertura + 0,3 · precisión. */
  score: number
}

/** `text`: título y canal del resultado, sin duración ni visualizaciones. */
export function matchVideo(query: string, text: string): VideoMatch {
  const asked = words(query)
  const found = words(text).filter((w) => !DESCRIPTIVE.has(w) || asked.includes(w))
  if (asked.length === 0 || found.length === 0) return { coverage: 0, precision: 0, score: 0 }
  const coverage = containmentSimilarity(asked, found.join(' '))
  const precision = containmentSimilarity(found, asked.join(' '))
  return { coverage, precision, score: 0.7 * coverage + 0.3 * precision }
}

/** Un resultado es candidato si contiene todas las palabras pedidas. */
export function isFullMatch(match: VideoMatch): boolean {
  return match.coverage >= 1
}

/**
 * Motor de coincidencia aproximada (fuzzy matching) para selección de canciones.
 * Implementa similitud Levenshtein, Jaro-Winkler, análisis de tokens y puntuación ponderada.
 */

/**
 * Calcula la distancia de Levenshtein entre dos strings.
 * Rango: 0 (igual) a máximo(len(a), len(b)) (completamente diferente).
 */
export function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = []

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i]
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const cost = a[j - 1] === b[i - 1] ? 0 : 1
      matrix[i][j] = Math.min(
        matrix[i][j - 1] + 1, // Inserción
        matrix[i - 1][j] + 1, // Eliminación
        matrix[i - 1][j - 1] + cost, // Sustitución
      )
    }
  }

  return matrix[b.length][a.length]
}

/**
 * Calcula similitud Levenshtein normalizada (0-1).
 * 1 = igual, 0 = completamente diferente.
 */
export function levenshteinSimilarity(a: string, b: string): number {
  if (a === b) return 1
  if (a.length === 0 || b.length === 0) return 0

  const maxLen = Math.max(a.length, b.length)
  const distance = levenshteinDistance(a, b)
  return 1 - distance / maxLen
}

/**
 * Calcula similitud Jaro-Winkler (más tolerante con errores al principio).
 * Rango: 0-1, donde 1 es coincidencia perfecta.
 */
export function jaroWinklerSimilarity(a: string, b: string): number {
  if (a === b) return 1
  if (a.length === 0 || b.length === 0) return 0

  const maxLen = Math.max(a.length, b.length)
  const matchWindow = Math.floor(maxLen / 2) - 1

  const aMatches = new Array(a.length).fill(false)
  const bMatches = new Array(b.length).fill(false)

  let matches = 0
  let transpositions = 0

  // Encontrar coincidencias
  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - matchWindow)
    const end = Math.min(i + matchWindow + 1, b.length)

    for (let j = start; j < end; j++) {
      if (bMatches[j] || a[i] !== b[j]) continue
      aMatches[i] = true
      bMatches[j] = true
      matches++
      break
    }
  }

  if (matches === 0) return 0

  // Contar transposiciones
  let k = 0
  for (let i = 0; i < a.length; i++) {
    if (!aMatches[i]) continue
    while (!bMatches[k]) k++
    if (a[i] !== b[k]) transpositions++
    k++
  }

  const jaro = (matches / a.length + matches / b.length + (matches - transpositions / 2) / matches) / 3

  // Jaro-Winkler: dar más peso a coincidencias al inicio
  const prefix = Math.min(4, a.length)
  let commonPrefix = 0
  for (let i = 0; i < prefix; i++) {
    if (a[i] === b[i]) commonPrefix++
    else break
  }

  return jaro + commonPrefix * 0.1 * (1 - jaro)
}

/** Palabras de 4 letras o menos solo cuentan si son exactas («numb» nunca es «dumb»). */
const TYPO_MIN_LENGTH = 5
/** Una letra cambiada, sobrante o faltante en una palabra de 5 o más («conspirancy» → «conspiracy»). */
const TYPO_MIN_SIMILARITY = 0.8

/** La palabra está en el conjunto tal cual o con un error de escritura razonable. */
function hasToken(token: string, tokens: Set<string>): boolean {
  if (tokens.has(token)) return true
  if (token.length < TYPO_MIN_LENGTH) return false
  for (const candidate of tokens) {
    if (candidate.length >= TYPO_MIN_LENGTH && levenshteinSimilarity(token, candidate) >= TYPO_MIN_SIMILARITY) {
      return true
    }
  }
  return false
}

/**
 * Similitud de tokens: porcentaje de palabras que coinciden entre dos strings (tolera errores de
 * escritura en palabras largas).
 */
export function tokenSimilarity(a: string, b: string): number {
  const tokensA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean))
  const tokensB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean))

  if (tokensA.size === 0 || tokensB.size === 0) return 0

  let matches = 0
  for (const token of tokensA) {
    if (hasToken(token, tokensB)) matches++
  }

  // Usar la media armónica (F1 score)
  const precision = matches / tokensA.size
  const recall = matches / tokensB.size
  const f1 = (2 * precision * recall) / (precision + recall)

  return f1 || 0
}

/**
 * Similitud de contenido: si todos los tokens de A están en B (aunque no en el mismo orden).
 * Útil para detectar si un título contiene todos los términos de búsqueda.
 */
export function containmentSimilarity(searchTerms: string[], resultText: string): number {
  if (searchTerms.length === 0) return 0
  const resultTokens = new Set(resultText.toLowerCase().split(/\s+/).filter(Boolean))
  const matches = searchTerms.filter((term) => hasToken(term, resultTokens)).length
  return matches / searchTerms.length
}

export interface SimilarityScores {
  titleSimilarity: number
  artistSimilarity: number
  tokenSimilarity: number
  versionIndicators: number
  overallScore: number
  reasoning: string
}

export interface ExtractedQuery {
  title: string
  artist: string
  version: string
  originalQuery: string
}

/**
 * Extrae título, artista y versión de una búsqueda de música.
 * Ejemplo: "conspiracy de paramore" → {title: "conspiracy", artist: "paramore", version: ""}
 */
export function extractMusicQuery(query: string): ExtractedQuery {
  const normalized = query.toLowerCase().trim()

  // Detectar patrones: "canción de artista", "canción by artista", etc.
  const patterns = [
    /^(.+?)\s+de\s+(.+?)(?:\s+(acústica|acoustic|live|cover|remix))?$/i,
    /^(.+?)\s+by\s+(.+?)(?:\s+(acústica|acoustic|live|cover|remix))?$/i,
    /^(.+?)(?:\s+(acústica|acoustic|live|cover|remix))?(?:\s+de|by)\s+(.+)$/i,
  ]

  for (const pattern of patterns) {
    const match = normalized.match(pattern)
    if (match) {
      return {
        title: match[1]?.trim() || '',
        artist: match[2]?.trim() || match[3]?.trim() || '',
        version: match[2]?.trim() || match[3]?.trim() || '',
        originalQuery: query,
      }
    }
  }

  // Si no hay patrón claro, asumir que todo es el título
  return {
    title: normalized,
    artist: '',
    version: '',
    originalQuery: query,
  }
}

/**
 * Detecta indicadores de versión (live, acoustic, etc.) en el texto.
 */
export function detectVersionIndicators(text: string): number {
  const lowerText = text.toLowerCase()
  const versionKeywords = [
    'acústica',
    'acoustic',
    'live',
    'en vivo',
    'cover',
    'remix',
    'official',
    'audio',
    'video',
    'extended',
    'remaster',
    'version',
  ]

  let score = 0
  for (const keyword of versionKeywords) {
    if (lowerText.includes(keyword)) {
      score += 0.5
    }
  }
  return Math.min(1, score)
}

/**
 * Calcula puntuación de similitud general entre búsqueda y resultado.
 * Ponderación: Título 55%, Artista 30%, Tokens 10%, Indicadores 5%
 */
export function scoreMatch(query: ExtractedQuery, videoTitle: string, weights?: Partial<Record<string, number>>): SimilarityScores {
  const defaultWeights = {
    title: 0.55,
    artist: 0.3,
    tokens: 0.1,
    indicators: 0.05,
  }

  const finalWeights = { ...defaultWeights, ...weights }

  // Similitud del título
  const titleSim = jaroWinklerSimilarity(query.title, videoTitle)

  // Similitud del artista (si existe)
  let artistSim = 0
  if (query.artist) {
    artistSim = jaroWinklerSimilarity(query.artist, videoTitle)
  }

  // Similitud de tokens
  const tokenSim = tokenSimilarity(query.title, videoTitle)

  // Indicadores de versión
  const versionScore = query.version ? detectVersionIndicators(videoTitle) : 0

  // Bonus: si todos los tokens de la query aparecen en el video, dar boost
  const queryTokens = query.title.toLowerCase().split(/\s+/).filter(Boolean)
  const containment = queryTokens.length > 0 ? containmentSimilarity(queryTokens, videoTitle) : 0
  const containmentBonus = containment === 1.0 ? 0.15 : 0

  // Puntuación ponderada
  const overall =
    titleSim * finalWeights.title + artistSim * finalWeights.artist + tokenSim * finalWeights.tokens + versionScore * finalWeights.indicators + containmentBonus

  // Generar razón
  let reasoning = ''
  if (overall >= 0.88) {
    reasoning = `Coincidencia muy alta: título=${(titleSim * 100).toFixed(0)}%, artista=${(artistSim * 100).toFixed(0)}%`
  } else if (overall >= 0.72) {
    reasoning = `Coincidencia moderada: título=${(titleSim * 100).toFixed(0)}%, tokens=${(tokenSim * 100).toFixed(0)}%`
  } else {
    reasoning = `Coincidencia baja: puntuación=${(overall * 100).toFixed(0)}%`
  }

  return {
    titleSimilarity: titleSim,
    artistSimilarity: artistSim,
    tokenSimilarity: tokenSim,
    versionIndicators: versionScore,
    overallScore: overall,
    reasoning,
  }
}

export interface ConfidenceLevel {
  level: 'auto' | 'confirm' | 'reject'
  score: number
  message: string
}

/**
 * Determina el nivel de confianza basado en la puntuación.
 * - 0.88-1.00: reproducción automática
 * - 0.72-0.87: solicitar confirmación
 * - <0.72: rechazar (no reproducir automáticamente)
 */
export function getConfidenceLevel(score: number): ConfidenceLevel {
  if (score >= 0.88) {
    return {
      level: 'auto',
      score,
      message: 'Coincidencia muy probable. Reproduciendo automáticamente.',
    }
  }

  if (score >= 0.72) {
    return {
      level: 'confirm',
      score,
      message: 'Coincidencia posible. Solicitar confirmación al usuario.',
    }
  }

  return {
    level: 'reject',
    score,
    message: 'Coincidencia insuficiente. No reproducir automáticamente.',
  }
}

/**
 * Encuentra el mejor candidato entre múltiples resultados.
 * Verifica que el mejor candidato esté suficientemente separado del segundo lugar.
 */
export interface CandidateResult {
  element: { name: string; [key: string]: unknown }
  score: number
  confidence: ConfidenceLevel
  reasoning: string
}

export function findBestCandidate(
  candidates: Array<{ name: string; [key: string]: unknown }>,
  query: ExtractedQuery,
  minSeparation: number = 0.08,
): CandidateResult | null {
  if (candidates.length === 0) return null

  const scored = candidates
    .map((candidate) => {
      const scores = scoreMatch(query, candidate.name)
      return {
        element: candidate,
        score: scores.overallScore,
        confidence: getConfidenceLevel(scores.overallScore),
        reasoning: scores.reasoning,
      }
    })
    .sort((a, b) => b.score - a.score)

  if (scored.length === 0) return null

  const best = scored[0]
  const second = scored[1]

  // Verificar separación mínima entre primero y segundo
  if (second && best.score - second.score < minSeparation) {
    return {
      ...best,
      confidence: { ...best.confidence, level: 'confirm' },
      reasoning: `Ambiguedad detectada: diferencia mínima entre resultados (${((best.score - second.score) * 100).toFixed(0)}%). Confirmar con usuario.`,
    }
  }

  return best
}

/**
 * Encuentra los 5 mejores candidatos ordenados por similitud.
 * Retorna hasta 5 resultados (o menos si hay pocos candidatos).
 */
export function findTopCandidates(
  candidates: Array<{ name: string; [key: string]: unknown }>,
  query: ExtractedQuery,
): CandidateResult[] {
  if (candidates.length === 0) return []

  const scored = candidates
    .map((candidate) => {
      const scores = scoreMatch(query, candidate.name)
      return {
        element: candidate,
        score: scores.overallScore,
        confidence: getConfidenceLevel(scores.overallScore),
        reasoning: scores.reasoning,
      }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 5) // Top 5

  return scored
}

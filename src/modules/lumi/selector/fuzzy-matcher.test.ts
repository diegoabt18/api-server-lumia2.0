/**
 * Pruebas para el motor de fuzzy matching de selección de canciones.
 * Casos de prueba: 8 búsquedas reales de música con variaciones y typos.
 */

import {
  extractMusicQuery,
  findBestCandidate,
  getConfidenceLevel,
  jaroWinklerSimilarity,
  levenshteinSimilarity,
  scoreMatch,
} from './fuzzy-matcher.js'

/**
 * Simula resultados reales de YouTube para pruebas.
 * Formato: {name: string} similar a Element.name en el navegador
 */

const TEST_CASES = [
  {
    name: 'Test 1: "reproduce conspiracy de paramore"',
    query: 'reproduce conspiracy de paramore',
    youtubeResults: [
      'Paramore - Conspiracy (Official Audio)',
      'Paramore - The Only Exception (Official Audio)',
      'Paramore - Misery Business (Official Audio)',
      'CONSPIRACY Theory - Full Documentary',
    ],
    expectedTitle: 'Paramore - Conspiracy (Official Audio)',
    expectedConfidence: 'auto',
  },

  {
    name: 'Test 2: "reproduce conspiraci de paramore" (typo)',
    query: 'reproduce conspiraci de paramore',
    youtubeResults: [
      'Paramore - Conspiracy (Official Audio)',
      'Paramore - The Only Exception (Official Audio)',
      'Other - Conspiracy (Different Band)',
    ],
    expectedTitle: 'Paramore - Conspiracy (Official Audio)',
    expectedConfidence: 'auto',
  },

  {
    name: 'Test 3: "pon nunk de linkin park" (typo)',
    query: 'pon nunk de linkin park',
    youtubeResults: [
      'Linkin Park - Numb (Official Audio)',
      'Linkin Park - In The End (Official Audio)',
      'Numb - Other Band',
    ],
    expectedTitle: 'Linkin Park - Numb (Official Audio)',
    expectedConfidence: 'auto',
  },

  {
    name: 'Test 4: "reproduce numb linkin park"',
    query: 'reproduce numb linkin park',
    youtubeResults: [
      'Linkin Park - Numb (Official Audio)',
      'Numb - Another Band',
      'Linkin Park - In The End',
    ],
    expectedTitle: 'Linkin Park - Numb (Official Audio)',
    expectedConfidence: 'auto',
  },

  {
    name: 'Test 5: "reproduce in the end de linkin park"',
    query: 'reproduce in the end de linkin park',
    youtubeResults: [
      'Linkin Park - In The End (Official Audio)',
      'Linkin Park - In The End (Lyric Video)',
      'In The End - Other Artist',
    ],
    expectedTitle: 'Linkin Park - In The End (Official Audio)',
    expectedConfidence: 'auto',
  },

  {
    name: 'Test 6: "pon bohemian rapsody de queen"',
    query: 'pon bohemian rapsody de queen',
    youtubeResults: [
      'Queen - Bohemian Rhapsody (Official Audio)',
      'Queen - Bohemian Rhapsody (Remastered)',
      'Bohemian Rhapsody - Cover Band',
    ],
    expectedTitle: 'Queen - Bohemian Rhapsody (Official Audio)',
    expectedConfidence: 'auto',
  },

  {
    name: 'Test 7: "reproduce la versión acústica de" (versión específica)',
    query: 'reproduce lagrimas acustica',
    youtubeResults: [
      'Lagrimas Acústica - Artist Name',
      'Lagrimas (Full Album)',
      'Lagrimas - Live Concert',
    ],
    expectedTitle: 'Lagrimas Acústica - Artist Name',
    expectedConfidence: 'confirm',
  },

  {
    name: 'Test 8: "reproduce la versión en vivo" (live version)',
    query: 'reproduce under the bridge live',
    youtubeResults: [
      'Red Hot Chili Peppers - Under the Bridge Live',
      'Red Hot Chili Peppers - Under the Bridge (Studio)',
      'Under the Bridge - Other Band',
    ],
    expectedTitle: 'Red Hot Chili Peppers - Under the Bridge Live',
    expectedConfidence: 'auto',
  },
]

/**
 * Ejecutar todas las pruebas y mostrar resultados.
 */
export function runAllTests() {
  console.log('🎵 Pruebas de Fuzzy Matching para Selección de Canciones\n')
  console.log('═'.repeat(80))

  let passed = 0
  let failed = 0

  for (const testCase of TEST_CASES) {
    console.log(`\n${testCase.name}`)
    console.log('─'.repeat(80))

    const result = runSingleTest(testCase)
    if (result.passed) {
      passed++
      console.log('✅ PASÓ')
    } else {
      failed++
      console.log('❌ FALLÓ')
      console.log(`   Esperado: ${result.expectedTitle} (${result.expectedConfidence})`)
      console.log(`   Obtenido: ${result.actualTitle} (${result.actualConfidence})`)
    }

    console.log(`\n   Búsqueda: "${testCase.query}"`)
    console.log(`   Resultado seleccionado: ${result.actualTitle}`)
    console.log(`   Puntuación: ${(result.score * 100).toFixed(1)}%`)
    console.log(`   Confianza: ${result.actualConfidence}`)
    console.log(`   Razón: ${result.reasoning}`)
  }

  console.log(`\n${'═'.repeat(80)}`)
  console.log(`\n📊 Resultados: ${passed} pasaron, ${failed} fallaron`)
  console.log(`   Tasa de éxito: ${((passed / TEST_CASES.length) * 100).toFixed(1)}%`)

  return { passed, failed, total: TEST_CASES.length }
}

interface TestResult {
  passed: boolean
  expectedTitle: string
  actualTitle: string
  expectedConfidence: string
  actualConfidence: string
  score: number
  reasoning: string
}

function runSingleTest(testCase: (typeof TEST_CASES)[0]): TestResult {
  const musicQuery = extractMusicQuery(testCase.query)

  const candidates = testCase.youtubeResults.map((name) => ({ name }))

  const best = findBestCandidate(candidates, musicQuery)

  const actualTitle = best?.element.name || 'NINGUNO'
  const actualConfidence = best?.confidence.level || 'reject'
  const score = best?.score || 0
  const reasoning = best?.reasoning || 'No hay coincidencia suficiente'

  const passed =
    actualTitle === testCase.expectedTitle && actualConfidence === testCase.expectedConfidence

  return {
    passed,
    expectedTitle: testCase.expectedTitle,
    actualTitle,
    expectedConfidence: testCase.expectedConfidence,
    actualConfidence,
    score,
    reasoning,
  }
}

/**
 * Pruebas de algoritmos individuales para debugging.
 */
export function testAlgorithms() {
  console.log('\n🔧 Pruebas de Algoritmos Individuales\n')

  // Test Levenshtein
  console.log('Levenshtein Distance:')
  console.log(`  "conspiracy" vs "conspiraci": ${levenshteinSimilarity('conspiracy', 'conspiraci') * 100 | 0}%`)
  console.log(`  "numb" vs "nunk": ${levenshteinSimilarity('numb', 'nunk') * 100 | 0}%`)

  // Test Jaro-Winkler
  console.log('\nJaro-Winkler Similarity:')
  console.log(`  "conspiracy" vs "conspiraci": ${(jaroWinklerSimilarity('conspiracy', 'conspiraci') * 100).toFixed(1)}%`)
  console.log(`  "numb" vs "nunk": ${(jaroWinklerSimilarity('numb', 'nunk') * 100).toFixed(1)}%`)

  // Test Extract
  console.log('\nExtracción de Componentes:')
  const q1 = extractMusicQuery('reproduce conspiracy de paramore')
  console.log(`  "reproduce conspiracy de paramore"`)
  console.log(`    → Título: "${q1.title}", Artista: "${q1.artist}", Versión: "${q1.version}"`)

  const q2 = extractMusicQuery('pon numb linkin park')
  console.log(`  "pon numb linkin park"`)
  console.log(`    → Título: "${q2.title}", Artista: "${q2.artist}"`)

  // Test Scoring
  console.log('\nSimilarity Scoring:')
  const scores = scoreMatch(
    { title: 'conspiracy', artist: 'paramore', version: '', originalQuery: 'conspiracy de paramore' },
    'paramore conspiracy official audio',
  )
  console.log(`  Query: "conspiracy de paramore"`)
  console.log(`  Resultado: "Paramore - Conspiracy (Official Audio)"`)
  console.log(`    → Título: ${(scores.titleSimilarity * 100).toFixed(1)}%`)
  console.log(`    → Artista: ${(scores.artistSimilarity * 100).toFixed(1)}%`)
  console.log(`    → Tokens: ${(scores.tokenSimilarity * 100).toFixed(1)}%`)
  console.log(`    → General: ${(scores.overallScore * 100).toFixed(1)}%`)

  // Test Confidence Levels
  console.log('\nNiveles de Confianza:')
  console.log(`  0.95 → ${getConfidenceLevel(0.95).level} (${getConfidenceLevel(0.95).message})`)
  console.log(`  0.80 → ${getConfidenceLevel(0.80).level} (${getConfidenceLevel(0.80).message})`)
  console.log(`  0.65 → ${getConfidenceLevel(0.65).level} (${getConfidenceLevel(0.65).message})`)
}

// Ejecutar pruebas si se invoca directamente
if (import.meta.url === `file://${process.argv[1]}`) {
  runAllTests()
  testAlgorithms()
}

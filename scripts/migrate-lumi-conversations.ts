/**
 * Migración del historial de Lumi de la SQLite de la IA Assistant a MongoDB (Lumi 2.0, Fase 1).
 *
 *   1. En la IA Assistant: python scripts/export_conversations.py --db data/assistant.db --out export.json
 *   2. Aquí:               npx tsx scripts/migrate-lumi-conversations.ts --file export.json          → simulación
 *                          npx tsx scripts/migrate-lumi-conversations.ts --file export.json --apply  → escribe
 *
 * - Por defecto NO escribe nada: muestra qué insertaría.
 * - Idempotente: una conversación ya migrada (mismo dueño y número de mensajes) se salta; si difiere,
 *   se informa como conflicto y no se toca.
 * - Tras escribir, verifica en la base que cada conversación tiene exactamente sus mensajes.
 * - No imprime contenido de mensajes: solo identificadores y recuentos.
 * - Hacer copia de seguridad antes (scripts/backup-mongo.ts) y borrar el JSON al terminar.
 */
import { readFileSync } from 'node:fs'
import { MongoClient } from 'mongodb'
import { loadEnv, MONGO_DB_NAMES } from '../src/config/env.js'
import { configureDnsForMongoSrv } from '../src/config/dns.js'
import {
  conversationExportSchema,
  planImport,
  type ExistingConversation,
} from '../src/modules/lumi/conversation/conversation.migration.js'
import {
  CONVERSATIONS_COLLECTION,
  MESSAGES_COLLECTION,
  MongoConversationStore,
} from '../src/modules/lumi/conversation/conversation.store.js'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main(): Promise<number> {
  const file = arg('file')
  if (!file) throw new Error('Falta --file <export.json>')
  const apply = process.argv.includes('--apply')
  const data = conversationExportSchema.parse(JSON.parse(readFileSync(file, 'utf8')))

  const env = loadEnv()
  configureDnsForMongoSrv()
  const client = await MongoClient.connect(env.MONGO_AUTH_URI)
  try {
    const db = client.db(MONGO_DB_NAMES.identity)
    const conversations = db.collection(CONVERSATIONS_COLLECTION)
    const ids = data.conversations.map((c) => c.id)
    const existing = new Map<string, ExistingConversation>()
    for (const doc of await conversations
      .find({ _id: { $in: ids } } as never, { projection: { userId: 1, messageCount: 1 } })
      .toArray()) {
      existing.set(String(doc._id), {
        userId: String(doc.userId),
        messageCount: Number(doc.messageCount),
      })
    }

    const plan = planImport(data, existing)
    console.log(
      `export: conversations=${data.conversations.length} skippedWithoutOwner=${data.skippedWithoutOwner}\n` +
        `plan:   insert conversations=${plan.conversations.length} messages=${plan.messages.length}\n` +
        `        alreadyImported=${plan.alreadyImported.length} empty=${plan.empty.length} conflicts=${plan.conflicts.length}`,
    )
    for (const c of plan.conflicts) console.log(`  CONFLICT ${c.id}: ${c.reason}`)
    if (!apply) {
      console.log('simulación: no se escribió nada (añade --apply para migrar)')
      return plan.conflicts.length ? 2 : 0
    }

    await new MongoConversationStore(db).ensureIndexes()
    if (plan.conversations.length) {
      await conversations.insertMany(plan.conversations as never[], { ordered: false })
      await db
        .collection(MESSAGES_COLLECTION)
        .insertMany(plan.messages as never[], { ordered: false })
    }

    // Verificación: cada conversación insertada tiene exactamente sus mensajes, con seq 1..n.
    let bad = 0
    for (const conv of plan.conversations) {
      const seqs = await db
        .collection(MESSAGES_COLLECTION)
        .find({ conversationId: conv._id, status: 'complete' }, { projection: { seq: 1 } })
        .sort({ seq: 1 })
        .toArray()
      const ok = seqs.length === conv.messageCount && seqs.every((m, i) => m.seq === i + 1)
      if (!ok) {
        bad += 1
        console.log(
          `  VERIFY FAILED ${conv._id}: expected ${conv.messageCount}, found ${seqs.length}`,
        )
      }
    }
    console.log(
      `verificación: ${plan.conversations.length - bad}/${plan.conversations.length} correctas`,
    )
    return bad || plan.conflicts.length ? 2 : 0
  } finally {
    await client.close()
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  },
)

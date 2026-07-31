import { MongoClient, Db, type MongoClientOptions } from 'mongodb'
import { MONGO_DB_NAMES } from '../../config/env.js'
import type { AppLogger } from '../../config/logger.js'

const DEFAULT_OPTIONS: MongoClientOptions = {
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 60000,
}

type DbKey = keyof typeof MONGO_DB_NAMES

interface ConnectionState {
  client: MongoClient | null
  db: Db | null
}

export class MongoConnectionManager {
  private readonly states = new Map<DbKey, ConnectionState>()
  private readonly logger: AppLogger

  constructor(logger: AppLogger) {
    this.logger = logger
    for (const key of Object.keys(MONGO_DB_NAMES) as DbKey[]) {
      this.states.set(key, { client: null, db: null })
    }
  }

  async getDb(key: DbKey, uri: string): Promise<Db> {
    const dbName = MONGO_DB_NAMES[key]
    const state = this.states.get(key)!

    if (state.client && state.db) {
      try {
        await state.client.db(dbName).command({ ping: 1 })
        return state.db
      } catch {
        this.logger.warn({ db: dbName }, 'MongoDB connection stale, reconnecting')
        await this.closeOne(key)
      }
    }

    const client = new MongoClient(uri, DEFAULT_OPTIONS)
    await client.connect()
    const db = client.db(dbName)

    this.states.set(key, { client, db })
    this.logger.info({ db: dbName }, 'MongoDB connected')
    return db
  }

  async ping(key: DbKey, uri: string): Promise<boolean> {
    try {
      const db = await this.getDb(key, uri)
      await db.command({ ping: 1 })
      return true
    } catch {
      return false
    }
  }

  async closeOne(key: DbKey): Promise<void> {
    const state = this.states.get(key)
    if (state?.client) {
      await state.client.close().catch(() => {})
    }
    this.states.set(key, { client: null, db: null })
  }

  async closeAll(): Promise<void> {
    for (const key of this.states.keys()) {
      await this.closeOne(key)
    }
  }
}

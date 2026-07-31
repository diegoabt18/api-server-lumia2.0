import type { Env } from '../../../config/env.js'

function inferDatabaseTier(mongoUri: string, nodeEnv: string): 'production' | 'staging' | 'development' {
  if (nodeEnv === 'development') return 'development'
  const lower = mongoUri.toLowerCase()
  if (lower.includes('localhost') || lower.includes('127.0.0.1')) return 'development'
  if (lower.includes('dev') || lower.includes('staging') || lower.includes('test')) return 'staging'
  return 'production'
}

export class AdminMetaService {
  constructor(private readonly env: Env) {}

  getMeta() {
    const uri = this.env.MONGO_CATALOG_URI
    const isAtlas = uri.includes('mongodb.net')
    const tier = inferDatabaseTier(uri, this.env.NODE_ENV)

    return {
      nodeEnv: this.env.NODE_ENV,
      database: {
        provider: isAtlas ? 'atlas' : 'local',
        tier,
      },
      apiUrl: this.env.APP_URL,
    }
  }
}

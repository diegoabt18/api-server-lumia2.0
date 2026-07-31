import { configureDnsForMongoSrv } from '../src/config/dns.js'
import { loadEnv } from '../src/config/env.js'
import { MongoClient } from 'mongodb'

configureDnsForMongoSrv()
const env = loadEnv()
const client = new MongoClient(env.MONGO_AUTH_URI, { serverSelectionTimeoutMS: 15000 })

try {
  await client.connect()
  await client.db('identity_db').command({ ping: 1 })
  console.log('OK: identity_db Atlas')
} catch (err) {
  console.error('FAIL:', err instanceof Error ? err.message : err)
  process.exit(1)
} finally {
  await client.close()
}

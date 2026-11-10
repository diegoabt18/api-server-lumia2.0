import { describe, it, expect, vi } from 'vitest'
import { AuthAuditRepository } from '../../src/modules/identity/infrastructure/auth-audit.repository.js'
import { AdminAuditService } from '../../src/modules/admin/services/admin-audit.service.js'

const CREATED = new Date('2026-11-01T10:00:00.000Z')
const LEGACY = new Date('2026-10-01T08:00:00.000Z')

/** Colección falsa: devuelve `docs` y registra el filtro y el orden usados. */
function fakeRepo(docs: Record<string, unknown>[]) {
  const calls: { filter?: unknown; sort?: unknown } = {}
  const cursor = {
    sort: vi.fn((s: unknown) => {
      calls.sort = s
      return cursor
    }),
    skip: vi.fn(() => cursor),
    limit: vi.fn(() => cursor),
    toArray: vi.fn(async () => docs),
  }
  const collection = {
    find: vi.fn((f: unknown) => {
      calls.filter = f
      return cursor
    }),
    countDocuments: vi.fn(async () => docs.length),
  }
  const db = { collection: vi.fn(() => collection) }
  return { repo: new AuthAuditRepository(db as never), calls }
}

const base = { event: 'LOGIN_SUCCESS', email: 'ana@lumia.test' }

describe('auth audit log: records without createdAt', () => {
  it('uses createdAt, falls back to the legacy `timestamp` field, and tolerates missing dates', async () => {
    const { repo } = fakeRepo([
      { _id: 'a', ...base, createdAt: CREATED },
      { _id: 'b', ...base, timestamp: LEGACY },
      { _id: 'c', ...base },
    ])
    const { items } = await repo.query({ limit: 50, skip: 0 })
    expect(items.map((i) => i.createdAt)).toEqual([CREATED, LEGACY, null])
  })

  it('does not fail the whole page when a record has no date (was HTTP 500)', async () => {
    const { repo } = fakeRepo([
      { _id: 'a', ...base, createdAt: CREATED },
      { _id: 'c', ...base },
    ])
    const res = await new AdminAuditService(repo).list({})
    expect(res.items.map((i) => i.timestamp)).toEqual([CREATED.toISOString(), null])
  })

  it('includes legacy records in date ranges and combines the range with the search', async () => {
    const { repo, calls } = fakeRepo([])
    const from = new Date('2026-10-01T00:00:00.000Z')
    await repo.query({ limit: 50, skip: 0, from, search: 'ana' })
    expect(calls.filter).toEqual({
      $and: [
        { $or: [{ createdAt: { $gte: from } }, { createdAt: { $exists: false }, timestamp: { $gte: from } }] },
        { $or: [{ email: /ana/i }, { event: /ana/i }, { ip: /ana/i }] },
      ],
    })
    expect(calls.sort).toEqual({ createdAt: -1, timestamp: -1 })
  })
})
